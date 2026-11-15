# JARVIS-CORE Phase-0 Engineering & RMA Domain Primer
## 1. Offline UPS Diagnostics & Component-Level Repair
- Relay Transfer Time: Standard offline UPS transfer time must be under 8ms-10ms. Measured via ZMPT101B AC sensor and optocoupler zero-crossing detector on Raspberry Pi Pico / ESP32.
- Battery Health & Recovery: 12V 7Ah / 9Ah SLA batteries require float charging at 13.6V-13.8V. Under load test, terminal voltage dropping below 10.5V indicates sulfation or cell dead.
- Inverter & MOSFET Stage: Check gate drive PWM waveform before replacing burnt IRFZ44N / IRF3205 MOSFETs. Inspect step-up transformer primary winding resistance.
## 2. ERP, RMA Serial Tracking & Barcode Automation
- Serial Intake Verification: Cross-check physical barcode serials with ERP stock transfer challans.
- Turnaround Time (TAT): Calculate net working days excluding Fridays and Bangladesh public holidays.
## 3. JARVIS-CORE Architecture Standards
- Frozen Core: Never modify kernel.js or preload.js. All capabilities live in 00_ENGINE/kernel_*.js extensions or 00_ENGINE/tools/*.js CommonJS modules.
- Security Rules 1-5: Local execution only, Fail-Closed audit logging, Automatic PII/Password Masking, Zero heavy npm dependencies, Strict 01_CONFIG write prohibition.