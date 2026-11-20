from __future__ import annotations

import gc
import importlib.util
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


class WorkerEngineError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 500, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


@dataclass
class LoadedModelMetadata:
    model_id: str
    model_name: str
    repo_id: Optional[str]
    revision: Optional[str]
    local_model_path: Optional[str]
    compatibility_status: str
    modality: str
    compression: Optional[str]
    layer_shards_saving_path: Optional[str]


class BaseAirLlmEngine:
    backend_mode: str = "base"

    def health_info(self) -> Dict[str, Any]:
        raise NotImplementedError

    def list_models(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def get_loaded_model_id(self) -> Optional[str]:
        raise NotImplementedError

    def load_model(self, spec: LoadedModelMetadata) -> Dict[str, Any]:
        raise NotImplementedError

    def unload_model(self, model_name: str) -> Dict[str, Any]:
        raise NotImplementedError

    def infer(
        self,
        model_name: str,
        messages: List[Dict[str, str]],
        max_new_tokens: int,
        temperature: Optional[float],
        timeout_ms: int,
        cancel_event: threading.Event,
    ) -> Dict[str, Any]:
        raise NotImplementedError


def _format_messages(messages: List[Dict[str, str]], tokenizer: Any = None) -> str:
    if tokenizer is not None and hasattr(tokenizer, "apply_chat_template"):
        try:
            rendered = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            if isinstance(rendered, str) and rendered:
                return rendered
        except Exception:
            pass

    lines: List[str] = []
    for msg in messages:
        role = msg.get("role", "user").upper()
        content = msg.get("content", "")
        lines.append(f"{role}: {content}")
    lines.append("ASSISTANT:")
    return "\n".join(lines)


class RealAirLlmEngine(BaseAirLlmEngine):
    """
    Production AirLLM engine wrapper around `airllm.AutoModel`.
    Lazily imports heavy ML libraries only when invoked so the worker control plane
    and offline tests run without GPU or large weights installed.
    """

    backend_mode = "airllm"

    def __init__(self, allow_remote_hub_download: bool = False) -> None:
        self._lock = threading.Lock()
        self._model: Any = None
        self._loaded_meta: Optional[LoadedModelMetadata] = None
        self._allow_remote_hub_download = allow_remote_hub_download

    @staticmethod
    def is_airllm_installed() -> bool:
        return (
            importlib.util.find_spec("airllm") is not None
            and importlib.util.find_spec("torch") is not None
        )

    def health_info(self) -> Dict[str, Any]:
        installed = self.is_airllm_installed()
        device = "unavailable"
        if installed:
            try:
                import torch  # type: ignore

                device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                device = "unknown"

        return {
            "airllm_installed": installed,
            "backend_mode": self.backend_mode,
            "loaded_model_id": self._loaded_meta.model_id if self._loaded_meta else None,
            "device": device,
        }

    def list_models(self) -> List[Dict[str, Any]]:
        if not self._loaded_meta:
            return []
        return [
            {
                "model_id": self._loaded_meta.model_id,
                "model_name": self._loaded_meta.model_name,
                "repo_id": self._loaded_meta.repo_id,
                "revision": self._loaded_meta.revision,
                "local_model_path": self._loaded_meta.local_model_path,
                "compatibility_status": self._loaded_meta.compatibility_status,
                "modality": self._loaded_meta.modality,
                "loaded": True,
            }
        ]

    def get_loaded_model_id(self) -> Optional[str]:
        return self._loaded_meta.model_id if self._loaded_meta else None

    def load_model(self, spec: LoadedModelMetadata) -> Dict[str, Any]:
        if not self.is_airllm_installed():
            raise WorkerEngineError(
                "AIRLLM_DEPENDENCY_MISSING",
                "Python package 'airllm' or 'torch' is not installed in this environment.",
                status_code=503,
                retryable=False,
            )

        source_path = spec.local_model_path or spec.repo_id
        if not source_path:
            raise WorkerEngineError(
                "MISSING_MODEL_SOURCE",
                "Either local_model_path or repo_id is required to load an AirLLM model.",
                status_code=400,
            )

        if not self._allow_remote_hub_download and not (
            spec.local_model_path and os.path.exists(spec.local_model_path)
        ):
            raise WorkerEngineError(
                "LOCAL_MODEL_PATH_NOT_FOUND",
                "Automatic remote model downloading is disabled; pre-stage verified weights at local_model_path.",
                status_code=422,
            )

        with self._lock:
            self._release_locked()
            try:
                from airllm import AutoModel  # type: ignore

                kwargs: Dict[str, Any] = {}
                if spec.compression in ("4bit", "8bit"):
                    kwargs["compression"] = spec.compression
                if spec.layer_shards_saving_path:
                    kwargs["layer_shards_saving_path"] = spec.layer_shards_saving_path
                if spec.revision and not spec.local_model_path:
                    kwargs["revision"] = spec.revision

                self._model = AutoModel.from_pretrained(source_path, **kwargs)
                self._loaded_meta = spec
            except WorkerEngineError:
                raise
            except Exception as exc:
                self._release_locked()
                raise WorkerEngineError(
                    "AIRLLM_LOAD_FAILED",
                    f"AirLLM failed to load model '{spec.model_name}': {exc}",
                    status_code=500,
                ) from exc

        return {
            "loaded": True,
            "model_id": spec.model_id,
            "model_name": spec.model_name,
        }

    def _release_locked(self) -> None:
        self._model = None
        self._loaded_meta = None
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def unload_model(self, model_name: str) -> Dict[str, Any]:
        with self._lock:
            was_loaded = self._loaded_meta is not None and (
                self._loaded_meta.model_name == model_name
                or self._loaded_meta.model_id == model_name
            )
            self._release_locked()
        return {"unloaded": True, "was_loaded": was_loaded, "model_name": model_name}

    def infer(
        self,
        model_name: str,
        messages: List[Dict[str, str]],
        max_new_tokens: int,
        temperature: Optional[float],
        timeout_ms: int,
        cancel_event: threading.Event,
    ) -> Dict[str, Any]:
        if not self.is_airllm_installed():
            raise WorkerEngineError(
                "AIRLLM_DEPENDENCY_MISSING",
                "Python package 'airllm' or 'torch' is not installed in this environment.",
                status_code=503,
            )

        with self._lock:
            if self._model is None or self._loaded_meta is None:
                raise WorkerEngineError(
                    "MODEL_NOT_LOADED",
                    f"Model '{model_name}' is not currently loaded in AirLLM worker.",
                    status_code=409,
                    retryable=True,
                )
            if (
                self._loaded_meta.model_name != model_name
                and self._loaded_meta.model_id != model_name
            ):
                raise WorkerEngineError(
                    "DIFFERENT_MODEL_LOADED",
                    f"Worker currently holds '{self._loaded_meta.model_name}', not '{model_name}'.",
                    status_code=409,
                    retryable=True,
                )

            if cancel_event.is_set():
                raise WorkerEngineError(
                    "REQUEST_CANCELLED",
                    "Inference request was cancelled before generation started.",
                    status_code=499,
                )

            start = time.monotonic()
            deadline = start + max(0.05, timeout_ms / 1000.0)

            try:
                import torch  # type: ignore
                from transformers import StoppingCriteria, StoppingCriteriaList  # type: ignore

                class _DeadlineCancelCriteria(StoppingCriteria):
                    def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
                        return cancel_event.is_set() or time.monotonic() >= deadline

                tokenizer = self._model.tokenizer
                prompt = _format_messages(messages, tokenizer)
                encoded = tokenizer(
                    [prompt],
                    return_tensors="pt",
                    return_attention_mask=False,
                    truncation=True,
                    padding=True,
                )
                input_ids = encoded["input_ids"]
                if torch.cuda.is_available():
                    input_ids = input_ids.cuda()

                gen_kwargs: Dict[str, Any] = {
                    "max_new_tokens": max_new_tokens,
                    "use_cache": True,
                    "return_dict_in_generate": True,
                    "stopping_criteria": StoppingCriteriaList([_DeadlineCancelCriteria()]),
                }
                if temperature is not None and temperature > 0:
                    gen_kwargs["do_sample"] = True
                    gen_kwargs["temperature"] = temperature

                generation_output = self._model.generate(input_ids, **gen_kwargs)

                if cancel_event.is_set():
                    raise WorkerEngineError(
                        "REQUEST_CANCELLED",
                        "Inference request was cancelled during AirLLM generation.",
                        status_code=499,
                    )
                if time.monotonic() >= deadline:
                    raise WorkerEngineError(
                        "REQUEST_TIMEOUT",
                        f"AirLLM generation exceeded timeout of {timeout_ms}ms.",
                        status_code=408,
                        retryable=True,
                    )

                sequences = (
                    generation_output.sequences
                    if hasattr(generation_output, "sequences")
                    else generation_output
                )
                prompt_len = int(input_ids.shape[-1])
                new_tokens = sequences[0][prompt_len:]
                output_text = tokenizer.decode(new_tokens, skip_special_tokens=True)
                completion_tokens = int(len(new_tokens))
                return {
                    "output_text": output_text,
                    "finish_reason": "stop",
                    "usage": {
                        "prompt_tokens": prompt_len,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_len + completion_tokens,
                    },
                }
            except WorkerEngineError:
                raise
            except Exception as exc:
                raise WorkerEngineError(
                    "AIRLLM_INFERENCE_FAILED",
                    f"AirLLM generation failed: {exc}",
                    status_code=500,
                ) from exc


class MockAirLlmEngine(BaseAirLlmEngine):
    """
    Deterministic test/offline engine implementing the exact worker contract
    without GPU hardware or downloading multi-GB model weights.
    """

    backend_mode = "mock"

    def __init__(self, simulated_delay_sec: float = 0.0) -> None:
        self._lock = threading.Lock()
        self._loaded_meta: Optional[LoadedModelMetadata] = None
        self._simulated_delay_sec = simulated_delay_sec

    def health_info(self) -> Dict[str, Any]:
        return {
            "airllm_installed": False,
            "backend_mode": self.backend_mode,
            "loaded_model_id": self._loaded_meta.model_id if self._loaded_meta else None,
            "device": "mock-cpu",
        }

    def list_models(self) -> List[Dict[str, Any]]:
        if not self._loaded_meta:
            return []
        return [
            {
                "model_id": self._loaded_meta.model_id,
                "model_name": self._loaded_meta.model_name,
                "repo_id": self._loaded_meta.repo_id,
                "revision": self._loaded_meta.revision,
                "local_model_path": self._loaded_meta.local_model_path,
                "compatibility_status": self._loaded_meta.compatibility_status,
                "modality": self._loaded_meta.modality,
                "loaded": True,
            }
        ]

    def get_loaded_model_id(self) -> Optional[str]:
        return self._loaded_meta.model_id if self._loaded_meta else None

    def load_model(self, spec: LoadedModelMetadata) -> Dict[str, Any]:
        with self._lock:
            self._loaded_meta = spec
        return {
            "loaded": True,
            "model_id": spec.model_id,
            "model_name": spec.model_name,
        }

    def unload_model(self, model_name: str) -> Dict[str, Any]:
        with self._lock:
            was_loaded = self._loaded_meta is not None and (
                self._loaded_meta.model_name == model_name
                or self._loaded_meta.model_id == model_name
            )
            self._loaded_meta = None
        return {"unloaded": True, "was_loaded": was_loaded, "model_name": model_name}

    def infer(
        self,
        model_name: str,
        messages: List[Dict[str, str]],
        max_new_tokens: int,
        temperature: Optional[float],
        timeout_ms: int,
        cancel_event: threading.Event,
    ) -> Dict[str, Any]:
        deadline = time.monotonic() + max(0.02, timeout_ms / 1000.0)
        end_delay = time.monotonic() + self._simulated_delay_sec
        while time.monotonic() < end_delay:
            if cancel_event.is_set():
                raise WorkerEngineError(
                    "REQUEST_CANCELLED",
                    "Inference request cancelled.",
                    status_code=499,
                )
            if time.monotonic() >= deadline:
                raise WorkerEngineError(
                    "REQUEST_TIMEOUT",
                    f"Mock inference exceeded timeout of {timeout_ms}ms.",
                    status_code=408,
                    retryable=True,
                )
            time.sleep(0.01)

        if cancel_event.is_set():
            raise WorkerEngineError(
                "REQUEST_CANCELLED",
                "Inference request cancelled.",
                status_code=499,
            )

        last_user = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                last_user = msg.get("content", "")
                break

        return {
            "output_text": f"[mock-airllm:{model_name}] {last_user}".strip(),
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": max(1, len(last_user.split())),
                "completion_tokens": min(max_new_tokens, 8),
                "total_tokens": max(1, len(last_user.split())) + min(max_new_tokens, 8),
            },
        }
