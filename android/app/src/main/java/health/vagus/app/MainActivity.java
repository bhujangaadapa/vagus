package health.vagus.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import com.getcapacitor.BridgeActivity;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends BridgeActivity implements SensorEventListener {

    private static final int PERMISSION_REQ_CODE = 2001;
    private static final String PREFS_NAME = "vagus_hardware_pedometer_v2";
    private static final String KEY_DATE = "step_date";
    private static final String KEY_STORED_STEPS = "stored_today_steps";
    private static final String KEY_BASELINE = "step_baseline";
    private static final String KEY_LAST_RAW = "last_raw_hardware_steps";

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private Sensor stepDetectorSensor;
    private int lastRawHardwareSteps = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
            stepDetectorSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            java.util.ArrayList<String> permList = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                permList.add(Manifest.permission.CAMERA);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
                    permList.add(Manifest.permission.ACTIVITY_RECOGNITION);
                }
            }
            if (!permList.isEmpty()) {
                requestPermissions(permList.toArray(new String[0]), PERMISSION_REQ_CODE);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();

        registerSensors();

        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                WebSettings settings = webView.getSettings();
                String userAgent = settings.getUserAgentString();
                if (userAgent != null && userAgent.contains("; wv")) {
                    settings.setUserAgentString(userAgent.replace("; wv", ""));
                }
                settings.setSupportMultipleWindows(true);
                settings.setJavaScriptCanOpenWindowsAutomatically(true);

                webView.addJavascriptInterface(new HardwareStepBridge(), "AndroidHardwarePedometer");

                // Immediately dispatch stored persistent footsteps on app launch or resume
                int stored = getStoredTodaySteps();
                if (stored > 0) {
                    dispatchStepUpdate(stored);
                }
            }
        } catch (Exception ignored) {}
    }

    private void registerSensors() {
        if (sensorManager != null) {
            // STEP_DETECTOR provides immediate per-stride ticks (<100ms latency), exactly like StepUp
            if (stepDetectorSensor != null) {
                sensorManager.registerListener(this, stepDetectorSensor, SensorManager.SENSOR_DELAY_FASTEST, 0);
            }
            // STEP_COUNTER provides periodic ground-truth accumulator reconciliation
            if (stepCounterSensor != null) {
                sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_FASTEST, 0);
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_STEP_DETECTOR) {
            // Instant real-time stride tick as you walk
            int steps = incrementStep();
            dispatchStepUpdate(steps);
        } else if (event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            // Low-power hardware accumulator
            int totalHardwareSteps = (int) event.values[0];
            this.lastRawHardwareSteps = totalHardwareSteps;
            int steps = processHardwareSteps(totalHardwareSteps);
            dispatchStepUpdate(steps);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    /**
     * Real-time increment on each detected footstrike
     */
    private synchronized int incrementStep() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedDate = prefs.getString(KEY_DATE, "");
        int storedSteps = 0;
        if (todayStr.equals(savedDate)) {
            storedSteps = prefs.getInt(KEY_STORED_STEPS, 0);
        }
        storedSteps++;
        prefs.edit()
            .putString(KEY_DATE, todayStr)
            .putInt(KEY_STORED_STEPS, storedSteps)
            .apply();
        return storedSteps;
    }

    /**
     * Strictly monotonic daily footsteps: steps can only increase or remain constant on same calendar day
     */
    private synchronized int processHardwareSteps(int totalHardwareSteps) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedDate = prefs.getString(KEY_DATE, "");
        int storedSteps = prefs.getInt(KEY_STORED_STEPS, 0);
        int baseline = prefs.getInt(KEY_BASELINE, -1);
        int lastRaw = prefs.getInt(KEY_LAST_RAW, -1);

        if (!todayStr.equals(savedDate)) {
            // New calendar day!
            // If we have previous raw readings and the phone was not rebooted:
            if (lastRaw > 0 && totalHardwareSteps >= lastRaw && (totalHardwareSteps - lastRaw) < 40000) {
                // Morning steps taken before launching Vagus are automatically preserved!
                baseline = lastRaw;
                storedSteps = totalHardwareSteps - lastRaw;
            } else {
                baseline = totalHardwareSteps;
                storedSteps = 0;
            }

            prefs.edit()
                .putString(KEY_DATE, todayStr)
                .putInt(KEY_BASELINE, baseline)
                .putInt(KEY_STORED_STEPS, storedSteps)
                .putInt(KEY_LAST_RAW, totalHardwareSteps)
                .apply();

            return storedSteps;
        }

        // Always save latest raw count so tonight's midnight rollover knows the exact anchor
        prefs.edit().putInt(KEY_LAST_RAW, totalHardwareSteps).apply();

        if (baseline == -1 || totalHardwareSteps < baseline) {
            baseline = Math.max(0, totalHardwareSteps - storedSteps);
            prefs.edit().putInt(KEY_BASELINE, baseline).apply();
        }

        int calculated = Math.max(storedSteps, totalHardwareSteps - baseline);
        if (calculated > storedSteps) {
            prefs.edit().putInt(KEY_STORED_STEPS, calculated).apply();
        }
        return calculated;
    }

    public synchronized int getStoredTodaySteps() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedDate = prefs.getString(KEY_DATE, "");
        if (todayStr.equals(savedDate)) {
            int steps = prefs.getInt(KEY_STORED_STEPS, 0);
            if (steps == 11000) {
                // Clear legacy synthetic 11,000 artifact
                prefs.edit().putInt(KEY_STORED_STEPS, 0).apply();
                return 0;
            }
            return steps;
        }
        return 0;
    }

    public synchronized void calibrateBaseline(int targetSteps) {
        if (targetSteps == 11000) return; // Disallow legacy synthetic artifact
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        int raw = lastRawHardwareSteps;
        int baseline = raw > 0 ? Math.max(0, raw - targetSteps) : -1;

        prefs.edit()
            .putString(KEY_DATE, todayStr)
            .putInt(KEY_STORED_STEPS, targetSteps)
            .putInt(KEY_BASELINE, baseline)
            .putInt(KEY_LAST_RAW, raw)
            .apply();

        dispatchStepUpdate(targetSteps);
    }

    private void dispatchStepUpdate(int steps) {
        runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                if (webView != null) {
                    String js = "window.dispatchEvent(new CustomEvent('androidHardwareStep', { detail: { steps: " + steps + " } }));";
                    webView.evaluateJavascript(js, null);
                }
            } catch (Exception ignored) {}
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQ_CODE && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            registerSensors();
        }
    }

    public class HardwareStepBridge {
        @JavascriptInterface
        public int getLiveSteps() {
            return getStoredTodaySteps();
        }

        @JavascriptInterface
        public boolean isSensorAvailable() {
            return stepCounterSensor != null || stepDetectorSensor != null;
        }

        @JavascriptInterface
        public void setInitialBaseline(int currentSteps) {
            calibrateBaseline(currentSteps);
        }

        @JavascriptInterface
        public void requestCameraPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, PERMISSION_REQ_CODE);
                    }
                });
            }
        }

        @JavascriptInterface
        public void requestPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.ACTIVITY_RECOGNITION}, PERMISSION_REQ_CODE);
                    }
                });
            }
        }
    }
}
