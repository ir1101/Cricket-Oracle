import pytest

from oracle.evaluate import expected_calibration_error, reliability_bins


def test_reliability_bins_group_predictions_by_decile():
    bins = reliability_bins([0, 1, 1, 0, 1], [0.05, 0.08, 0.95, 0.62, 0.68])

    assert [(b["lo"], b["hi"], b["n"]) for b in bins] == [(0.0, 0.1, 2), (0.6, 0.7, 2), (0.9, 1.0, 1)]
    assert bins[0]["predicted"] == pytest.approx(0.065)
    assert bins[0]["observed"] == 0.5


def test_perfectly_calibrated_bins_have_no_calibration_error():
    y = [1] * 7 + [0] * 3 + [1] * 2 + [0] * 8
    p = [0.7] * 10 + [0.2] * 10
    assert expected_calibration_error(y, p) == pytest.approx(0)
