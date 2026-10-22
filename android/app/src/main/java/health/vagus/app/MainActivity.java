package health.vagus.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                WebSettings settings = webView.getSettings();
                String userAgent = settings.getUserAgentString();
                // Strip '; wv' and 'Version/4.0' so Google OAuth does not reject with 403 disallowed_useragent
                if (userAgent != null && userAgent.contains("; wv")) {
                    settings.setUserAgentString(userAgent.replace("; wv", ""));
                }
                settings.setSupportMultipleWindows(true);
                settings.setJavaScriptCanOpenWindowsAutomatically(true);
            }
        } catch (Exception e) {}
    }
}
