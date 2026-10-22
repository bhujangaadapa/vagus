# Vagus

> Open-source, subscription-free alternative to WHOOP. Autonomous biometric telemetry, physiological strain modeling, and vagal recovery diagnostics.

## Features
- **Physiological Math Engine**: Root Mean Square of Successive Differences (RMSSD), Banister TRIMP logarithmic strain (0.0 - 21.0), Autonomic Steering Index (`ln(RMSSD / RHR) * 10`), Cumulative Fatigue Drag, and Sleep Architecture Efficiency.
- **Biometric Ingestion**: Android Health Connect & Apple HealthKit via Capacitor, with realistic browser mock simulation.
- **Real-Time Allostasis**: AngularFire v13+ / Firebase Firestore reactive synchronization.
- **Minimalist Telemetry UI**: Dark mode slate telemetry HUD designed with Angular 22 & Tailwind CSS.

## Getting Started
```bash
npm install --legacy-peer-deps
npm start
```

## Production Build
```bash
npm run build
```
Build artifacts are placed in `dist/antigravity/browser/`.
