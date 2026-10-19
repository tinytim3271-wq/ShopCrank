"""Tests for the ShopCrank voice intake service.

Run with pytest or directly: python3 test_voice_service.py
"""
from __future__ import annotations

import sys
import os
import unittest

# Allow importing voice_service from the parent directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from voice_service import build_work_order, _match_symptom, SYMPTOM_RULES, DEFAULT_FLOW


class TestMatchSymptom(unittest.TestCase):
    """Unit tests for keyword-based symptom matching."""

    def test_no_start_keyword(self) -> None:
        result = _match_symptom("car won't start, just clicking")
        self.assertEqual(result, SYMPTOM_RULES["no-start"])

    def test_overheating_keyword(self) -> None:
        result = _match_symptom("Engine is overheating badly")
        self.assertEqual(result, SYMPTOM_RULES["overheating"])

    def test_brake_noise_keyword(self) -> None:
        result = _match_symptom("There is a grinding noise from the brakes")
        self.assertEqual(result, SYMPTOM_RULES["brake-noise"])

    def test_check_engine_keyword(self) -> None:
        result = _match_symptom("check engine light came on today")
        self.assertEqual(result, SYMPTOM_RULES["check-engine"])

    def test_transmission_keyword(self) -> None:
        result = _match_symptom("transmission is slipping on the highway")
        self.assertEqual(result, SYMPTOM_RULES["transmission"])

    def test_ac_keyword(self) -> None:
        result = _match_symptom("Air conditioning is not cooling")
        self.assertEqual(result, SYMPTOM_RULES["ac-heat"])

    def test_case_insensitive(self) -> None:
        result = _match_symptom("BRAKES ARE SQUEALING")
        self.assertEqual(result, SYMPTOM_RULES["brake-noise"])

    def test_default_flow_returned_for_unknown(self) -> None:
        result = _match_symptom("windshield wiper stopped working")
        self.assertEqual(result, DEFAULT_FLOW)


class TestBuildWorkOrder(unittest.TestCase):
    """Unit tests for build_work_order output schema."""

    def _make(self, **kwargs: object) -> dict:
        payload = {
            "call_transcript": "car won't start, clicking noise",
            "customer_name": "Jane Smith",
            "phone": "806-555-0100",
            "vehicle": "2019 Ford F-150",
        }
        payload.update(kwargs)
        return build_work_order(payload)

    def test_required_fields_present(self) -> None:
        wo = self._make()
        for key in ("work_order_id", "created_at", "customer", "call_summary",
                    "customer_statement", "estimate", "technician_instructions"):
            self.assertIn(key, wo)

    def test_work_order_id_format(self) -> None:
        wo = self._make()
        self.assertTrue(wo["work_order_id"].startswith("WO-"))

    def test_source_field(self) -> None:
        wo = self._make()
        self.assertEqual(wo["source"], "voice-intake")

    def test_customer_fields(self) -> None:
        wo = self._make()
        self.assertEqual(wo["customer"]["name"], "Jane Smith")
        self.assertEqual(wo["customer"]["phone"], "806-555-0100")
        self.assertEqual(wo["customer"]["vehicle"], "2019 Ford F-150")

    def test_estimate_total_calculation(self) -> None:
        wo = self._make()
        est = wo["estimate"]
        expected_total = round(est["labor_hours"] * est["labor_rate"] + est["parts_cost"], 2)
        self.assertAlmostEqual(est["total"], expected_total)

    def test_estimate_total_positive(self) -> None:
        wo = self._make()
        self.assertGreater(wo["estimate"]["total"], 0)

    def test_technician_instructions_structure(self) -> None:
        wo = self._make()
        ti = wo["technician_instructions"]
        self.assertIn("diagnostic_steps", ti)
        self.assertIn("repair_steps_after_root_cause_confirmed", ti)
        self.assertIsInstance(ti["diagnostic_steps"], list)
        self.assertGreater(len(ti["diagnostic_steps"]), 0)

    def test_missing_transcript_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_work_order({"customer_name": "Test"})

    def test_empty_transcript_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_work_order({"call_transcript": "   "})

    def test_custom_labor_rate(self) -> None:
        wo = build_work_order(
            {"call_transcript": "brakes grinding", "vehicle": "2020 Chevy"},
            labor_rate=150.0,
        )
        self.assertEqual(wo["estimate"]["labor_rate"], 150.0)

    def test_default_customer_name(self) -> None:
        wo = build_work_order({"call_transcript": "overheating"})
        self.assertEqual(wo["customer"]["name"], "Unknown Customer")

    def test_default_vehicle(self) -> None:
        wo = build_work_order({"call_transcript": "overheating"})
        self.assertEqual(wo["customer"]["vehicle"], "Vehicle not provided")


if __name__ == "__main__":
    unittest.main(verbosity=2)
