"""Voice intake micro-service for Shop Crank Dispatch.

Converts inbound-call transcripts into structured work orders that can be
imported directly into the dispatch board.

Ported from tinytim3271-wq/Reliable-Voice- and adapted for the unified
shopcrank-dispatch platform.

Usage
-----
Run as a standalone HTTP server (pure stdlib, zero pip installs):

    python3 diagnostics/voice-service/voice_service.py

The server listens on http://127.0.0.1:8080 by default.

POST /intake-call
    Content-Type: application/json

    {
      "call_transcript": "Customer says the car won't start, just clicking",
      "customer_name": "Jane Smith",
      "phone": "806-555-0100",
      "vehicle": "2019 Ford F-150"
    }

Responds with a JSON work-order object ready for the Shop Crank API or local
import.  The app.js AI phone form already mirrors this schema when generating
AI-assisted work orders from the in-app assistant.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from uuid import uuid4


# ---------------------------------------------------------------------------
# Estimate helper
# ---------------------------------------------------------------------------

@dataclass
class Estimate:
    labor_hours: float
    labor_rate: float
    parts_cost: float

    @property
    def total(self) -> float:
        return round((self.labor_hours * self.labor_rate) + self.parts_cost, 2)


# ---------------------------------------------------------------------------
# Symptom rule table – extend here to add new diagnostic pathways
# ---------------------------------------------------------------------------

SYMPTOM_RULES: dict[str, dict[str, Any]] = {
    "no-start": {
        "keywords": ("won't start", "wont start", "no start", "clicking", "dead battery"),
        "summary": "No-start condition reported",
        "diagnostics": [
            "Perform battery state-of-charge and load test.",
            "Inspect starter circuit voltage drop and starter relay operation.",
            "Scan for powertrain fault codes and verify crank/cam signal during cranking.",
        ],
        "repairs": [
            "Replace failed battery/starter/relay component identified during testing.",
            "Repair high-resistance or open circuit wiring in start system.",
            "Clear fault codes and verify multiple successful restart cycles.",
        ],
        "labor_hours": 2.0,
        "parts_cost": 150.0,
    },
    "overheating": {
        "keywords": ("overheat", "overheating", "hot", "temp high", "coolant"),
        "summary": "Engine overheating concern reported",
        "diagnostics": [
            "Pressure test cooling system and inspect for external leaks.",
            "Verify coolant flow, thermostat function, and radiator fan operation.",
            "Check for combustion gas intrusion and confirm water pump performance.",
        ],
        "repairs": [
            "Replace failed cooling component(s) found during diagnosis.",
            "Repair leaks and refill/bleed cooling system to specification.",
            "Road test under load and confirm normal operating temperature.",
        ],
        "labor_hours": 2.5,
        "parts_cost": 220.0,
    },
    "brake-noise": {
        "keywords": ("brake noise", "squeal", "grinding", "brakes"),
        "summary": "Brake noise/performance concern reported",
        "diagnostics": [
            "Inspect pad/shoe thickness and rotor/drum condition.",
            "Measure rotor runout/thickness variation and caliper operation.",
            "Evaluate hydraulic system, fluid condition, and road-test brake response.",
        ],
        "repairs": [
            "Replace worn pads/rotors/shoes/drums as required.",
            "Service or replace seized caliper or slide hardware.",
            "Bleed brakes and verify stopping performance with post-repair road test.",
        ],
        "labor_hours": 2.0,
        "parts_cost": 280.0,
    },
    "check-engine": {
        "keywords": ("check engine", "mil on", "cel", "dtc", "fault code", "code"),
        "summary": "MIL / check-engine light concern reported",
        "diagnostics": [
            "Retrieve all stored and pending DTCs with a full-system scan.",
            "Research TSBs and known failure patterns for retrieved codes.",
            "Perform pinpoint tests per manufacturer diagnostic procedure.",
        ],
        "repairs": [
            "Perform confirmed root-cause repair per OEM procedure.",
            "Clear DTCs, perform drive cycle, and verify no return of MIL.",
            "Document all codes, test results, and parts replaced.",
        ],
        "labor_hours": 1.5,
        "parts_cost": 80.0,
    },
    "transmission": {
        "keywords": ("transmission", "slipping", "won't shift", "shifting", "gear"),
        "summary": "Transmission concern reported",
        "diagnostics": [
            "Road-test to confirm shift quality, slip, and harsh engagement symptoms.",
            "Check transmission fluid level, color, and condition.",
            "Pull transmission DTCs and review live data (TFT, solenoid states, slip RPM).",
        ],
        "repairs": [
            "Perform fluid service if indicated by condition or maintenance history.",
            "Replace failed solenoid, sensor, or valve body component as confirmed.",
            "Re-test across full shift range and verify correction.",
        ],
        "labor_hours": 3.0,
        "parts_cost": 350.0,
    },
    "ac-heat": {
        "keywords": ("air conditioning", "a/c", "ac not", "no heat", "heater", "blower", "hvac"),
        "summary": "HVAC / climate control concern reported",
        "diagnostics": [
            "Verify customer complaint: measure vent temperatures and blower output.",
            "Check refrigerant pressure (A/C) and coolant temperature (heat).",
            "Scan HVAC module for DTCs; inspect blend doors and actuators.",
        ],
        "repairs": [
            "Recharge or repair A/C system leak as diagnosed.",
            "Replace failed blower motor, actuator, or HVAC control module.",
            "Verify system operation across all modes and temperatures.",
        ],
        "labor_hours": 2.0,
        "parts_cost": 180.0,
    },
}

DEFAULT_FLOW: dict[str, Any] = {
    "summary": "General drivability concern reported",
    "diagnostics": [
        "Interview customer concerns and verify complaint during inspection.",
        "Perform full-system scan for stored/active diagnostic trouble codes.",
        "Execute guided pinpoint tests for failed subsystem based on scan and symptom data.",
    ],
    "repairs": [
        "Perform repair based on confirmed root cause from diagnostic process.",
        "Re-test repaired system and clear/verify no returning faults.",
        "Provide documented findings and recommendations to service advisor.",
    ],
    "labor_hours": 1.5,
    "parts_cost": 120.0,
}


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _match_symptom(transcript: str) -> dict[str, Any]:
    """Return the best matching symptom rule for *transcript*, or DEFAULT_FLOW."""
    lowered = transcript.lower()
    for config in SYMPTOM_RULES.values():
        if any(keyword in lowered for keyword in config["keywords"]):
            return config
    return DEFAULT_FLOW


def build_work_order(payload: dict[str, Any], labor_rate: float = 120.0) -> dict[str, Any]:
    """Build a structured Shop Crank work-order dict from a raw call payload."""
    transcript = str(payload.get("call_transcript", "")).strip()
    if not transcript:
        raise ValueError("call_transcript is required")

    customer_name = str(payload.get("customer_name", "Unknown Customer")).strip() or "Unknown Customer"
    phone = str(payload.get("phone", "")).strip()
    vehicle = str(payload.get("vehicle", "Vehicle not provided")).strip() or "Vehicle not provided"

    symptom_plan = _match_symptom(transcript)
    estimate = Estimate(
        labor_hours=float(symptom_plan["labor_hours"]),
        labor_rate=float(labor_rate),
        parts_cost=float(symptom_plan["parts_cost"]),
    )

    return {
        "work_order_id": f"WO-{uuid4().hex.upper()[:12]}",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "voice-intake",
        "customer": {
            "name": customer_name,
            "phone": phone,
            "vehicle": vehicle,
        },
        "call_summary": symptom_plan["summary"],
        "customer_statement": transcript,
        "estimate": {
            **asdict(estimate),
            "total": estimate.total,
        },
        "technician_instructions": {
            "diagnostic_steps": symptom_plan["diagnostics"],
            "repair_steps_after_root_cause_confirmed": symptom_plan["repairs"],
        },
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class VoiceIntakeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for the /intake-call endpoint."""

    # Silence default request logging to keep output clean in production;
    # override with a proper logging framework if needed.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def _respond(self, code: int, body: dict[str, Any]) -> None:
        response = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(response)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._respond(200, {"status": "ok", "service": "voice-intake"})
            return
        self._respond(404, {"error": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/intake-call":
            self._respond(404, {"error": "Not Found"})
            return

        MAX_PAYLOAD = 65_536  # 64 KiB – more than sufficient for a call transcript
        try:
            raw_length = self.headers.get("Content-Length", "0")
            try:
                length = int(raw_length)
            except ValueError:
                self._respond(400, {"error": "Invalid Content-Length"})
                return
            if length < 0 or length > MAX_PAYLOAD:
                self._respond(400, {"error": "Payload size out of range"})
                return
            raw_payload = self.rfile.read(length)
            try:
                payload = json.loads(raw_payload or b"{}")
            except json.JSONDecodeError:
                self._respond(400, {"error": "Invalid JSON payload"})
                return
            if not isinstance(payload, dict):
                self._respond(400, {"error": "Request body must be a JSON object"})
                return
            work_order = build_work_order(payload)
            self._respond(200, work_order)
        except ValueError as exc:
            self._respond(400, {"error": str(exc)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(host: str = "127.0.0.1", port: int = 8080) -> None:
    server = ThreadingHTTPServer((host, port), VoiceIntakeHandler)
    print(f"Shop Crank voice-intake service listening on http://{host}:{port}")
    print("  POST /intake-call   — convert call transcript to work order")
    print("  GET  /healthz       — liveness check")
    print("Press Ctrl-C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    run()
