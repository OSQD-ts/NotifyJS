const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

/**
 * Lets an incoming call wake and take over a locked screen.
 *
 * The full-screen intent is only half of it: Android will not show the target
 * activity over the keyguard unless the activity itself says it may. These are
 * activity attributes, so they have to be patched into the app manifest rather
 * than declared by the module.
 */
module.exports = function withLockScreenCalls(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const activity = app.activity?.find(
      (a) => a.$['android:name'] === '.MainActivity',
    );
    if (!activity) throw new Error('MainActivity not found; cannot enable lock-screen calls');

    // Draw over the keyguard, and light the screen up when the call arrives.
    activity.$['android:showWhenLocked'] = 'true';
    activity.$['android:turnScreenOn'] = 'true';

    return cfg;
  });
};
