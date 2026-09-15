/**
 * Capacitor configuration for HOPPA.
 *
 * This file is what Capacitor reads (Meteor deep-merges it over its own
 * defaults). Committing it up front matters: if it is missing, Meteor
 * scaffolds one from the DIRECTORY NAME, which is how you end up shipping
 * `com.example.src` to a store.
 *
 * The factory receives a `Meteor` object populated by Meteor's capacitor
 * tooling — see the @meteorjs/capacitor README for the full flag list.
 * Useful here: isDevelopment, isProduction, isBundled, isLivereload,
 * isNativeAndroid, isNativeIos, platform, mode, rootUrl, webDir.
 */

const { defineConfig } = require('@meteorjs/capacitor');

module.exports = defineConfig((Meteor) => ({
  appId: 'com.kingofalldata.hoppa',
  appName: Meteor.isDevelopment ? 'HOPPA dev' : 'HOPPA',

  // game is portrait-locked in the PWA manifest; mirror that natively
  ios: {
    contentInset: 'always',
    backgroundColor: '#0b1020'
  },
  android: {
    backgroundColor: '#0b1020',
    allowMixedContent: Meteor.isLivereload
  },

  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      // instantaneous in dev, a beat in release
      launchShowDuration: Meteor.isDevelopment ? 0 : 400,
      backgroundColor: '#0b1020',
      showSpinner: false
    }
  },

  // remove this block once the game is known-good; it exists to keep the
  // native console quiet while we learn
  loggingBehavior: 'none'
}));
