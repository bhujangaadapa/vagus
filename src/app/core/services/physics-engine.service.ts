import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class PhysicsEngineService {
  /**
   * 1. Calculate RMSSD (Root Mean Square of Successive Differences)
   * Formula: sqrt( (1 / (N - 1)) * sum((RR[i+1] - RR[i])^2) )
   *
   * @param rrIntervalsMs Array of consecutive RR beat-to-beat intervals in milliseconds.
   * @returns RMSSD in milliseconds, rounded to 2 decimal places.
   */
  public calculateRMSSD(rrIntervalsMs: number[]): number {
    const n = rrIntervalsMs.length;
    if (n < 2) {
      return 0;
    }

    let sumSquaredDifferences = 0;
    for (let i = 0; i < n - 1; i++) {
      const difference = rrIntervalsMs[i + 1] - rrIntervalsMs[i];
      sumSquaredDifferences += difference * difference;
    }

    const meanSquaredDifference = sumSquaredDifferences / (n - 1);
    const rmssd = Math.sqrt(meanSquaredDifference);

    return Math.round(rmssd * 100) / 100;
  }

  /**
   * 2. Compute Daily Recovery Percent
   * A weighted composite score: 60% HRV (RMSSD) dynamic response and 40% RHR response
   * relative to individual physiological baseline norms.
   *
   * @param todayRMSSD Today's nocturnal RMSSD in ms.
   * @param baselineRMSSD Rolling 30-day baseline RMSSD in ms.
   * @param todayRHR Today's resting heart rate in bpm.
   * @param baselineRHR Rolling 30-day baseline resting heart rate in bpm.
   * @returns Recovery percentage strictly bound between 0 and 100.
   */
  public computeDailyRecoveryPercent(
    todayRMSSD: number,
    baselineRMSSD: number,
    todayRHR: number,
    baselineRHR: number
  ): number {
    const safeBaselineRMSSD = baselineRMSSD > 0 ? baselineRMSSD : 50;
    const safeBaselineRHR = baselineRHR > 0 ? baselineRHR : 60;

    // HRV subscore: Baseline maps to 50%. Elevated RMSSD trends upward toward 100%;
    // suppressed RMSSD trends downward toward 0%.
    const hrvRatio = todayRMSSD / safeBaselineRMSSD;
    const hrvScore = Math.min(100, Math.max(0, 50 + (hrvRatio - 1.0) * 80));

    // RHR subscore: For resting heart rate, lower values indicate positive parasympathetic tone.
    // Suppressed RHR below baseline yields >50%; elevated RHR yields <50%.
    const rhrDifferenceRatio = (safeBaselineRHR - todayRHR) / safeBaselineRHR;
    const rhrScore = Math.min(100, Math.max(0, 50 + rhrDifferenceRatio * 150));

    // 60% HRV weighted + 40% RHR weighted composite
    const compositeScore = (0.60 * hrvScore) + (0.40 * rhrScore);

    return Math.round(Math.min(100, Math.max(0, compositeScore)));
  }

  /**
   * 3. Calculate Accumulated Strain via Banister's TRIMP Algorithm
   * Heart rate reserve is integrated across temporal samples and asymptotically mapped
   * onto a logarithmic scale bound strictly between 0.0 and 21.0:
   * Equation: 21 * (1 - e^(-TRIMP / 25))
   *
   * @param heartRateSamples Heart rate readings sampled across the recording epoch (bpm).
   * @param rhr Individual resting heart rate (bpm).
   * @param maxHR Individual maximum physiological heart rate (bpm).
   * @returns Accumulated strain value between 0.0 and 21.0.
   */
  public calculateAccumulatedStrain(
    heartRateSamples: number[],
    rhr: number,
    maxHR: number
  ): number {
    if (!heartRateSamples || heartRateSamples.length === 0) {
      return 0.0;
    }

    const heartRateRange = Math.max(1, maxHR - rhr);
    let totalTrimp = 0.0;

    // Process each sample assuming a 1-minute integration step per sample
    for (let i = 0; i < heartRateSamples.length; i++) {
      const currentBpm = heartRateSamples[i];

      if (currentBpm > rhr) {
        // Fractional elevation in heart rate reserve (Delta HR)
        const fractionalReserve = (currentBpm - rhr) / heartRateRange;
        const boundedFraction = Math.min(1.0, Math.max(0.0, fractionalReserve));

        // Banister's TRIMP formula increment for 1 minute:
        // duration * deltaHR * 0.64 * e^(1.92 * deltaHR)
        const sampleTrimp = boundedFraction * 0.64 * Math.exp(1.92 * boundedFraction);
        totalTrimp += sampleTrimp;
      }
    }

    // Map TRIMP onto asymptotic 0.0 - 21.0 scale
    const strain = 21.0 * (1.0 - Math.exp(-totalTrimp / 25.0));

    return Math.round(Math.min(21.0, Math.max(0.0, strain)) * 10) / 10;
  }

  /**
   * 4. Calculate Autonomic Steering Index
   * Measures the balance between parasympathetic brake and sympathetic drive.
   * Formula: ln(rmssd / rhr) * 10
   *
   * @param rmssd Nocturnal RMSSD in ms.
   * @param rhr Resting heart rate in bpm.
   * @returns Steering index (positive = parasympathetic dominance, negative = sympathetic drive).
   */
  public calculateAutonomicSteering(rmssd: number, rhr: number): number {
    if (rmssd <= 0 || rhr <= 0) {
      return 0.0;
    }

    const steering = Math.log(rmssd / rhr) * 10.0;
    return Math.round(steering * 100) / 100;
  }

  /**
   * 5. Calculate Cumulative Fatigue Drag
   * Computes the 7-day cumulative net drag between daily cardiac strain load
   * and systemic recovery restitution.
   * Formula: Sum over 7 days of ((Strain / 21) - (Recovery / 100))
   *
   * @param rolling7DayLogs 7-day chronological sequence of strain and recovery logs.
   * @returns Cumulative Fatigue Drag value.
   */
  public calculateFatigueDrag(
    rolling7DayLogs: { strain: number; recovery: number }[]
  ): number {
    if (!rolling7DayLogs || rolling7DayLogs.length === 0) {
      return 0.0;
    }

    let netDragSum = 0.0;
    for (let i = 0; i < rolling7DayLogs.length; i++) {
      const entry = rolling7DayLogs[i];
      const normalizedStrain = entry.strain / 21.0;
      const normalizedRecovery = entry.recovery / 100.0;
      netDragSum += (normalizedStrain - normalizedRecovery);
    }

    return Math.round(netDragSum * 100) / 100;
  }

  /**
   * 6. Calculate Sleep Efficiency Coefficient
   * Combines sleep architecture density (restorative deep + REM sleep)
   * with nocturnal cardiovascular deceleration.
   * Formula: ((deepMin + remMin) / totalInBedMin) * (rhr / avgSleepHR)
   *
   * @param deepMin Minutes of slow-wave sleep.
   * @param remMin Minutes of REM sleep.
   * @param totalInBedMin Total minutes spent in bed.
   * @param rhr Baseline daytime resting heart rate.
   * @param avgSleepHR Average nocturnal heart rate while asleep.
   * @returns Dimensionless efficiency coefficient (typically 0.40 - 1.20).
   */
  public calculateSleepEfficiency(
    deepMin: number,
    remMin: number,
    totalInBedMin: number,
    rhr: number,
    avgSleepHR: number
  ): number {
    if (totalInBedMin <= 0 || avgSleepHR <= 0) {
      return 0.0;
    }

    const restorativeArchitectureRatio = (deepMin + remMin) / totalInBedMin;
    const cardiovascularDecelerationRatio = rhr / avgSleepHR;
    const coefficient = restorativeArchitectureRatio * cardiovascularDecelerationRatio;

    return Math.round(coefficient * 100) / 100;
  }

  /**
   * Calculate Target Strain Range based on today's Recovery Score
   * Provides prescriptive strain targets aligned with nervous system readiness.
   *
   * @param recovery Recovery percent (0 - 100).
   * @returns Object containing min and max target strain.
   */
  public calculateTargetStrain(recovery: number): { min: number; max: number; target: number } {
    if (recovery > 66) {
      // High Recovery: Green zone (prime for adaptation and high metabolic demand)
      const target = 14.0 + ((recovery - 66) / 34) * 6.0;
      return { min: 14.0, max: 20.5, target: Math.round(target * 10) / 10 };
    } else if (recovery >= 34) {
      // Moderate Recovery: Yellow zone (maintenance and controlled load)
      const target = 9.0 + ((recovery - 34) / 32) * 4.5;
      return { min: 9.0, max: 13.5, target: Math.round(target * 10) / 10 };
    } else {
      // Low Recovery: Red zone (active rest, systemic recovery prioritized)
      const target = 4.0 + (recovery / 34) * 4.0;
      return { min: 0.0, max: 8.0, target: Math.round(target * 10) / 10 };
    }
  }
}
