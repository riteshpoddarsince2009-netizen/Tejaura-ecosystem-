from __future__ import annotations

import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from airllm_engine import (
    BaseAirLlmEngine,
    LoadedModelMetadata,
    WorkerEngineError,
)

WORKER_TOKEN_HEADER = "X-TEJAURA-Worker-Token"
MAX_BODY_BYTES = 2 * 1024 * 1024


class WorkerState:
    def __init__(self, auth_token: str, engine: BaseAirLlmEngine) -> None:
        if not auth_token or len(auth_token.strip()) < 8:
            raise ValueError("TEJAURA AirLLM worker requires a non-empty auth token (>= 8 chars).")
        self.auth_token = auth_token.strip()
        self.engine = engine
        self._requests_lock = threading.Lock()
        self._active_requests: Dict[str, threading.Event] = {}

    def verify_token(self, provided: Optional[str]) -> bool:
        if not provided:
            return False
        return hmac.compare_digest(provided.strip(), self.auth_token)

    def register_request(self, request_id: str) -> threading.Event:
        event = threading.Event()
        with self._requests_lock:
            self._active_requests[request_id] = event
        return event

    def unregister_request(self, request_id: str) -> None:
        with self._requests_lock:
            self._active_requests.pop(request_id, None)

    def cancel_request(self, request_id: str) -> bool:
        with self._requests_lock:
            event = self._active_requests.get(request_id)
            if event is None:
                return False
            event.set()
            return True

    def active_count(self) -> int:
        with self._requests_lock:
            return len(self._active_requests)


def _error_payload(code: str, message: str, retryable: bool = False) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        },
    }


def make_handler_class(state: WorkerState) -> type[BaseHTTPRequestHandler]:
    class AirLlmWorkerHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Suppress noisy stdout logging in automated tests / mobile logs
            return

        def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _require_auth(self) -> bool:
            token = self.headers.get(WORKER_TOKEN_HEADER)
            if not state.verify_token(token):
                self._send_json(
                    401,
                    _error_payload(
                        "UNAUTHORIZED",
                        f"Valid {WORKER_TOKEN_HEADER} header is required.",
                    ),
                )
                return False
            return True

        def _read_json_body(self) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[int, Dict[str, Any]]]]:
            raw_len = self.headers.get("Content-Length", "0")
            try:
                content_length = int(raw_len)
            except ValueError:
                return None, (400, _error_payload("INVALID_CONTENT_LENGTH", "Content-Length must be an integer."))

            if content_length <= 0 or content_length > MAX_BODY_BYTES:
                return None, (
                    400,
                    _error_payload(
                        "INVALID_BODY_SIZE",
                        f"Request body size must be between 1 and {MAX_BODY_BYTES} bytes.",
                    ),
                )

            raw = self.rfile.read(content_length)
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                return None, (400, _error_payload("MALFORMED_JSON", "Request body must be valid JSON."))

            if not isinstance(parsed, dict):
                return None, (400, _error_payload("INVALID_JSON_OBJECT", "Request JSON must be an object."))

            return parsed, None

        def do_GET(self) -> None:
            if not self._require_auth():
                return

            path = urlparse(self.path).path
            if path == "/internal/health":
                health = state.engine.health_info()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "status": "ready",
                        "engine": "airllm",
                        "active_requests": state.active_count(),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        **health,
                    },
                )
                return

            if path == "/internal/models":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "models": state.engine.list_models(),
                        "loaded_model_id": state.engine.get_loaded_model_id(),
                    },
                )
                return

            self._send_json(404, _error_payload("NOT_FOUND", f"Unknown GET endpoint '{path}'."))

        def do_POST(self) -> None:
            if not self._require_auth():
                return

            path = urlparse(self.path).path
            body, err = self._read_json_body()
            if err is not None or body is None:
                status, payload = err  # type: ignore
                self._send_json(status, payload)
                return

            if path == "/internal/models/load":
                self._handle_load(body)
                return
            if path == "/internal/models/unload":
                self._handle_unload(body)
                return
            if path == "/internal/infer":
                self._handle_infer(body)
                return
            if path == "/internal/requests/cancel":
                self._handle_cancel(body)
                return

            self._send_json(404, _error_payload("NOT_FOUND", f"Unknown POST endpoint '{path}'."))

        def _handle_load(self, body: Dict[str, Any]) -> None:
            model_name = body.get("model_name")
            if not isinstance(model_name, str) or not model_name.strip():
                self._send_json(400, _error_payload("INVALID_REQUEST", "model_name is required."))
                return

            compat = body.get("compatibility_status", "untested")
            if compat != "verified":
                code = (
                    "MODEL_COMPATIBILITY_UNSUPPORTED"
                    if compat == "unsupported"
                    else "MODEL_COMPATIBILITY_UNTESTED"
                )
                self._send_json(
                    422,
                    _error_payload(
                        code,
                        f"Refusing to load '{model_name}': compatibility_status is '{compat}' (must be 'verified').",
                    ),
                )
                return

            modality = body.get("modality", "text")
            if modality != "text":
                self._send_json(
                    422,
                    _error_payload(
                        "UNSUPPORTED_AIRLLM_MODALITY",
                        f"Modality '{modality}' is not supported by the AirLLM text worker.",
                    ),
                )
                return

            spec = LoadedModelMetadata(
                model_id=str(body.get("model_id") or model_name),
                model_name=model_name,
                repo_id=body.get("repo_id") if isinstance(body.get("repo_id"), str) else None,
                revision=body.get("revision") if isinstance(body.get("revision"), str) else None,
                local_model_path=(
                    body.get("local_model_path")
                    if isinstance(body.get("local_model_path"), str)
                    else None
                ),
                compatibility_status=compat,
                modality=modality,
                compression=body.get("compression") if isinstance(body.get("compression"), str) else None,
                layer_shards_saving_path=(
                    body.get("layer_shards_saving_path")
                    if isinstance(body.get("layer_shards_saving_path"), str)
                    else None
                ),
            )
            try:
                result = state.engine.load_model(spec)
                self._send_json(200, {"ok": True, **result})
            except WorkerEngineError as exc:
                self._send_json(
                    exc.status_code,
                    _error_payload(exc.code, exc.message, exc.retryable),
                )

        def _handle_unload(self, body: Dict[str, Any]) -> None:
            model_name = body.get("model_name")
            if not isinstance(model_name, str) or not model_name.strip():
                self._send_json(400, _error_payload("INVALID_REQUEST", "model_name is required."))
                return

            result = state.engine.unload_model(model_name)
            self._send_json(200, {"ok": True, **result})

        def _handle_cancel(self, body: Dict[str, Any]) -> None:
            request_id = body.get("request_id")
            if not isinstance(request_id, str) or not request_id.strip():
                self._send_json(400, _error_payload("INVALID_REQUEST", "request_id is required."))
                return
            cancelled = state.cancel_request(request_id)
            self._send_json(200, {"ok": True, "request_id": request_id, "cancelled": cancelled})

        def _handle_infer(self, body: Dict[str, Any]) -> None:
            request_id = body.get("request_id")
            model_name = body.get("model_name")
            messages = body.get("messages")
            if (
                not isinstance(request_id, str)
                or not request_id.strip()
                or not isinstance(model_name, str)
                or not model_name.strip()
                or not isinstance(messages, list)
                or len(messages) == 0
            ):
                self._send_json(
                    400,
                    _error_payload(
                        "INVALID_REQUEST",
                        "request_id, model_name, and non-empty messages list are required.",
                    ),
                )
                return

            compat = body.get("compatibility_status", "untested")
            if compat != "verified":
                code = (
                    "MODEL_COMPATIBILITY_UNSUPPORTED"
                    if compat == "unsupported"
                    else "MODEL_COMPATIBILITY_UNTESTED"
                )
                self._send_json(
                    422,
                    _error_payload(
                        code,
                        f"Refusing inference for '{model_name}': compatibility_status is '{compat}'.",
                    ),
                )
                return

            modality = body.get("modality", "text")
            if modality != "text":
                self._send_json(
                    422,
                    _error_payload(
                        "UNSUPPORTED_AIRLLM_MODALITY",
                        f"Modality '{modality}' is disabled for AirLLM text inference.",
                    ),
                )
                return

            max_new_tokens = body.get("max_new_tokens", 256)
            if not isinstance(max_new_tokens, int) or max_new_tokens < 1:
                max_new_tokens = 256

            temperature = body.get("temperature")
            if temperature is not None and not isinstance(temperature, (int, float)):
                temperature = None

            timeout_ms = body.get("timeout_ms", 60000)
            if not isinstance(timeout_ms, int) or timeout_ms < 1:
                timeout_ms = 60000

            cancel_event = state.register_request(request_id)
            start = time.monotonic()
            try:
                result = state.engine.infer(
                    model_name=model_name,
                    messages=messages,
                    max_new_tokens=max_new_tokens,
                    temperature=float(temperature) if temperature is not None else None,
                    timeout_ms=timeout_ms,
                    cancel_event=cancel_event,
                )
                latency_ms = int((time.monotonic() - start) * 1000)
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "request_id": request_id,
                        "model_name": model_name,
                        "untrusted_model_output": True,
                        "latency_ms": latency_ms,
                        **result,
                    },
                )
            except WorkerEngineError as exc:
                self._send_json(
                    exc.status_code,
                    _error_payload(exc.code, exc.message, exc.retryable),
                )
            finally:
                state.unregister_request(request_id)

    return AirLlmWorkerHandler


def create_airllm_server(
    host: str,
    port: int,
    auth_token: str,
    engine: BaseAirLlmEngine,
) -> ThreadingHTTPServer:
    state = WorkerState(auth_token=auth_token, engine=engine)
    handler_cls = make_handler_class(state)
    return ThreadingHTTPServer((host, port), handler_cls)
