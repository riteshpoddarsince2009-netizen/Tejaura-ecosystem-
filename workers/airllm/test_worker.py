from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from airllm_engine import MockAirLlmEngine
from worker_protocol import WORKER_TOKEN_HEADER, create_airllm_server


def _request_json(
    url: str,
    method: str = "GET",
    body: dict | None = None,
    token: str | None = None,
) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers[WORKER_TOKEN_HEADER] = token

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


class AirLlmWorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.token = "test-airllm-worker-secret-token"
        self.engine = MockAirLlmEngine(simulated_delay_sec=0.05)
        self.server = create_airllm_server("127.0.0.1", 0, self.token, self.engine)
        port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_requires_internal_auth_token(self) -> None:
        status, payload = _request_json(f"{self.base_url}/internal/health")
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "UNAUTHORIZED")

        status_bad, _ = _request_json(f"{self.base_url}/internal/health", token="wrong-token")
        self.assertEqual(status_bad, 401)

    def test_health_load_infer_unload_and_rejects_unverified_and_modality(self) -> None:
        status, health = _request_json(f"{self.base_url}/internal/health", token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(health["engine"], "airllm")

        # Unverified model rejected
        status_unverified, payload_unverified = _request_json(
            f"{self.base_url}/internal/models/load",
            method="POST",
            token=self.token,
            body={
                "model_id": "unverified-model",
                "model_name": "unverified-model",
                "compatibility_status": "untested",
                "modality": "text",
            },
        )
        self.assertEqual(status_unverified, 422)
        self.assertEqual(payload_unverified["error"]["code"], "MODEL_COMPATIBILITY_UNTESTED")

        # Image generation modality rejected
        status_modality, payload_modality = _request_json(
            f"{self.base_url}/internal/models/load",
            method="POST",
            token=self.token,
            body={
                "model_id": "sdxl",
                "model_name": "sdxl",
                "compatibility_status": "verified",
                "modality": "image_generation",
            },
        )
        self.assertEqual(status_modality, 422)
        self.assertEqual(payload_modality["error"]["code"], "UNSUPPORTED_AIRLLM_MODALITY")

        # Verified text model loads, infers, and unloads cleanly
        status_load, _ = _request_json(
            f"{self.base_url}/internal/models/load",
            method="POST",
            token=self.token,
            body={
                "model_id": "llama-3.1-70b-q4",
                "model_name": "Llama-3.1-70B-Instruct",
                "repo_id": "meta-llama/Llama-3.1-70B-Instruct",
                "revision": "main",
                "compatibility_status": "verified",
                "modality": "text",
                "compression": "4bit",
            },
        )
        self.assertEqual(status_load, 200)

        status_models, models_payload = _request_json(
            f"{self.base_url}/internal/models",
            token=self.token,
        )
        self.assertEqual(status_models, 200)
        self.assertEqual(models_payload["loaded_model_id"], "llama-3.1-70b-q4")

        status_infer, infer_payload = _request_json(
            f"{self.base_url}/internal/infer",
            method="POST",
            token=self.token,
            body={
                "request_id": "req-1",
                "model_name": "Llama-3.1-70B-Instruct",
                "messages": [{"role": "user", "content": "Hello AirLLM"}],
                "compatibility_status": "verified",
                "modality": "text",
                "timeout_ms": 2000,
            },
        )
        self.assertEqual(status_infer, 200)
        self.assertTrue(infer_payload["ok"])
        self.assertTrue(infer_payload["untrusted_model_output"])
        self.assertIn("Hello AirLLM", infer_payload["output_text"])

        status_unload, unload_payload = _request_json(
            f"{self.base_url}/internal/models/unload",
            method="POST",
            token=self.token,
            body={"model_name": "Llama-3.1-70B-Instruct"},
        )
        self.assertEqual(status_unload, 200)
        self.assertTrue(unload_payload["unloaded"])


if __name__ == "__main__":
    unittest.main()
