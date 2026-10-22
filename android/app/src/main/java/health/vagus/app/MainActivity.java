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
    private static final String PREFS_NAME = "vagus_hardware_pedometer";
    private static final String KEY_DATE = "step_date";
    private static final String KEY_BASELINE = "step_baseline";
    private static final String KEY_LAST_STEPS = "last_today_steps";

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private int currentDailySteps = 0;
    private int lastRawHardwareSteps = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Initialize Android Hardware Step Counter
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        }

        // Request Activity Recognition Permission on Android 10+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.ACTIVITY_RECOGNITION}, PERMISSION_REQ_CODE);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();

        // Register Hardware Step Counter Listener
        if (sensorManager != null && stepCounterSensor != null) {
            sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_UI);
        }

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

                // Expose Direct Hardware Bridge to JavaScript
                webView.addJavascriptInterface(new HardwareStepBridge(), "AndroidHardwarePedometer");

                // Send latest known steps immediately to Web app
                dispatchStepUpdate(getStoredDailySteps());
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onPause() {
        super.onPause();
        // Sensor listener remains active or re-registers on resume
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
        if (event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            int totalHardwareSteps = (int) event.values[0];
            this.lastRawHardwareSteps = totalHardwareSteps;
            int dailySteps = calculateDailySteps(totalHardwareSteps);
            this.currentDailySteps = dailySteps;
            dispatchStepUpdate(dailySteps);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    /**
     * Calculate true daily footsteps relative to midnight baseline
     */
    private int calculateDailySteps(int totalHardwareSteps) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedDate = prefs.getString(KEY_DATE, "");
        int savedBaseline = prefs.getInt(KEY_BASELINE, -1);

        if (!todayStr.equals(savedDate) || savedBaseline == -1 || totalHardwareSteps < savedBaseline) {
            // New day or phone reboot: establish new baseline
            savedBaseline = totalHardwareSteps;
            prefs.edit()
                .putString(KEY_DATE, todayStr)
                .putInt(KEY_BASELINE, savedBaseline)
                .putInt(KEY_LAST_STEPS, 0)
                .apply();
            return 0;
        }

        int todaySteps = totalHardwareSteps - savedBaseline;
        prefs.edit().putInt(KEY_LAST_STEPS, todaySteps).apply();
        return Math.max(0, todaySteps);
    }

    private int getStoredDailySteps() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String savedDate = prefs.getString(KEY_DATE, "");
        if (todayStr.equals(savedDate)) {
            return prefs.getInt(KEY_LAST_STEPS, this.currentDailySteps);
        }
        return this.currentDailySteps;
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
            if (sensorManager != null && stepCounterSensor != null) {
                sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_UI);
            }
        }
    }

    /**
     * JavaScript Interface Bridge exposed as window.AndroidHardwarePedometer
     */
    public class HardwareStepBridge {
        @JavascriptInterface
        public int getLiveSteps() {
            return getStoredDailySteps();
        }

        @JavascriptInterface
        public boolean isSensorAvailable() {
            return stepCounterSensor != null;
        }

        @JavascriptInterface
        public void setInitialBaseline(int currentSteps) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String todayStr = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            int baseline = Math.max(0, lastRawHardwareSteps - currentSteps);
            prefs.edit()
                .putString(KEY_DATE, todayStr)
                .putInt(KEY_BASELINE, baseline)
                .putInt(KEY_LAST_STEPS, currentSteps)
                .apply();
            currentDailySteps = currentSteps;
            dispatchStepUpdate(currentSteps);
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
