import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'health.vagus.app',
  appName: 'Vagus',
  webDir: 'dist/antigravity/browser',
  server: {
    url: 'https://vagus-nine.vercel.app',
    cleartext: true,
  },
};

export default config;
