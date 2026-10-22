import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'health.vagus.app',
  appName: 'Vagus',
  webDir: 'dist/antigravity/browser',
  server: {
    androidScheme: 'https',
  },
};

export default config;
