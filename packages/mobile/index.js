import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';
import { hub } from './src/hub';

registerRootComponent(App);

/**
 * The way in when nobody has opened the app.
 *
 * `registerRootComponent` only *registers* a component - it mounts nothing -
 * so a process Android started for its own reasons (a reboot, a service
 * restart) had a JavaScript runtime with no tree in it, and therefore no
 * connection to any hub. This is the entry point that does not need a screen:
 * the native watch service starts it, and it hands off to the same `hub`
 * singleton the UI subscribes to, so whichever arrives first the phone ends up
 * with exactly one manager and one socket per source.
 *
 * It does not return once connected. React Native only fires JavaScript timers
 * for a backgrounded app while a headless task is running, and the client's
 * keepalive, watchdog and reconnect are all timers - so the task stays open
 * for as long as the phone is meant to be watching.
 */
AppRegistry.registerHeadlessTask('NotifyjsWatch', () => async () => {
  await hub.start();
  await hub.whileWatching();
});
