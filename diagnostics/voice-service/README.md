# ShopCrank Voice Intake Service

Converts inbound-call transcripts into structured work orders that import
directly into the ShopCrank dispatch board.

**Source:** ported from [`tinytim3271-wq/Reliable-Voice-`](https://github.com/tinytim3271-wq/Reliable-Voice-)  
**Dependencies:** Python 3.9+ standard library only — no `pip install` required.

---

## Quick Start

```bash
python3 diagnostics/voice-service/voice_service.py
# ShopCrank voice-intake service listening on http://127.0.0.1:8080
```

## API

### `POST /intake-call`

**Request:**
```json
{
  "call_transcript": "Customer says the car won't start, just clicking sound",
  "customer_name": "Jane Smith",
  "phone": "806-555-0100",
  "vehicle": "2019 Ford F-150"
}
```

**Response (200):**
```json
{
  "work_order_id": "WO-A1B2C3D4E5F6",
  "created_at": "2026-09-01T11:00:00+00:00",
  "source": "voice-intake",
  "customer": {
    "name": "Jane Smith",
    "phone": "806-555-0100",
    "vehicle": "2019 Ford F-150"
  },
  "call_summary": "No-start condition reported",
  "customer_statement": "Customer says the car won't start, just clicking sound",
  "estimate": {
    "labor_hours": 2.0,
    "labor_rate": 120.0,
    "parts_cost": 150.0,
    "total": 390.0
  },
  "technician_instructions": {
    "diagnostic_steps": ["..."],
    "repair_steps_after_root_cause_confirmed": ["..."]
  }
}
```

### `GET /healthz`
Returns `{"status": "ok", "service": "voice-intake"}` — use for liveness probes.

## Supported Symptom Categories

| Category | Trigger keywords |
|---|---|
| No-start | won't start, clicking, dead battery |
| Overheating | overheat, coolant, temp high |
| Brake noise | brake noise, squeal, grinding, brakes |
| Check engine | check engine, cel, dtc, fault code |
| Transmission | transmission, slipping, shifting, gear |
| A/C & Heat | air conditioning, a/c, no heat, hvac |
| Default | (anything else) |

## Integration with ShopCrank app

The JSON schema returned by `/intake-call` mirrors the work-order structure
used by `app.js` (see the `aiPhoneForm` and `aiWorkflowForm` functions). To
import a voice-generated work order into the running app, POST the response
body to your configured backend or use the **AI Phone** tool in the
Workbench panel to paste the transcript directly.

## Running tests

```bash
python3 diagnostics/voice-service/tests/test_voice_service.py
# optional if you already use pytest:
python3 -m pytest diagnostics/voice-service/tests/ -v
```
