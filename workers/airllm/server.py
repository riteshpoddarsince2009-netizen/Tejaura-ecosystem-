from __future__ import annotations

import argparse
import os
import sys

from airllm_engine import MockAirLlmEngine, RealAirLlmEngine
from worker_protocol import create_airllm_server


def main() -> int:
    parser = argparse.ArgumentParser(description="TEJAURA AirLLM Internal Worker Service")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Bind port (default: 8765)")
    parser.add_argument(
        "--mode",
        choices=["airllm", "mock"],
        default="airllm",
        help="Execution backend mode (airllm or mock)",
    )
    parser.add_argument(
        "--mock-delay-ms",
        type=int,
        default=0,
        help="Simulated delay in milliseconds when --mode=mock",
    )
    args = parser.parse_args()

    token = os.environ.get("TEJAURA_AIRLLM_WORKER_TOKEN", "").strip()
    if len(token) < 8:
        print(
            "ERROR: TEJAURA_AIRLLM_WORKER_TOKEN must be set (>= 8 characters). Failing closed.",
            file=sys.stderr,
        )
        return 1

    engine = (
        MockAirLlmEngine(simulated_delay_sec=max(0, args.mock_delay_ms) / 1000.0)
        if args.mode == "mock"
        else RealAirLlmEngine()
    )

    server = create_airllm_server(args.host, args.port, token, engine)
    bound_host, bound_port = server.server_address[:2]
    print(
        f"TEJAURA AirLLM worker listening on http://{bound_host}:{bound_port} (mode={args.mode})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
