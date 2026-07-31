/**
 * macOS notarization, invoked by electron-builder's afterSign hook.
 *
 * Skips cleanly and loudly when credentials are absent. That matters more than
 * it sounds: a fork, a pull request from outside the repo, and any local `npm
 * run dist:mac` all have no Apple credentials, and none of them should fail the
 * build. They get a working unsigned app instead — which Gatekeeper will warn
 * about on first launch, and that is the honest outcome rather than a red CI.
 */
exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== 'darwin') return;

    const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
    const missing = [
        ['APPLE_ID', APPLE_ID],
        ['APPLE_APP_SPECIFIC_PASSWORD', APPLE_APP_SPECIFIC_PASSWORD],
        ['APPLE_TEAM_ID', APPLE_TEAM_ID],
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) {
        console.log(`  • notarization skipped — missing ${missing.join(', ')}`);
        console.log('    The .app and .dmg are still produced, unsigned.');
        return;
    }

    // Required only on the path where notarization actually runs, so the skip
    // path above does not depend on the package being installed.
    let notarize;
    try {
        ({ notarize } = require('@electron/notarize'));
    } catch {
        console.log('  • notarization skipped — @electron/notarize is not installed');
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;
    console.log(`  • notarizing ${appPath} (this takes several minutes)`);

    const started = Date.now();
    await notarize({
        tool: 'notarytool',
        appPath,
        appleId: APPLE_ID,
        appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
        teamId: APPLE_TEAM_ID,
    });
    console.log(`  • notarized in ${Math.round((Date.now() - started) / 1000)}s`);
};
