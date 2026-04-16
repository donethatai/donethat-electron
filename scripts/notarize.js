import dotenv from 'dotenv';
import { notarize } from 'electron-notarize';
import path from 'path';

dotenv.config();

export default async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== 'darwin') {
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;
    const appBundleId = 'com.donethat.app'; // Make sure this matches your app's bundle ID

    // --- App Store Connect API Key Credentials (Preferred) ---
    const apiKey = process.env.APP_STORE_CONNECT_KEY_ID;
    const apiIssuer = process.env.APP_STORE_CONNECT_ISSUER_ID;
    // Consider storing the key content directly in an env var or reading from a secure location
    const apiKeyPathRaw = process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH; // Or load the key content directly

    // --- Legacy Apple ID Credentials (Fallback) ---
    const appleId = process.env.APPLEID || process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLEIDPASS || process.env.APPLE_ID_PASSWORD; // Should be an app-specific password
    const teamId = process.env.APPLETEAMID || process.env.APPLE_TEAM_ID; // Team ID is needed for Apple ID method

    let notarizeOptions;

    if (apiKey && apiIssuer && apiKeyPathRaw) {
        const apiKeyPath = path.isAbsolute(apiKeyPathRaw)
            ? apiKeyPathRaw
            : path.resolve(process.cwd(), apiKeyPathRaw);

        console.log('Using App Store Connect API Key for notarization.');
        notarizeOptions = {
            tool: 'notarytool',
            appBundleId: appBundleId,
            appPath: appPath,
            // Use apiKey, apiIssuer, and potentially apiKeyPath or apiKeyContent
            // electron-notarize expects either `appleApiKey` (path) or `appleApiKeyContent`
            appleApiKey: apiKeyPath, // Assuming env var holds the PATH to the .p8 file
            appleApiKeyId: apiKey,
            appleApiIssuer: apiIssuer,
            verbose: true,
        };
        if (teamId) {
            notarizeOptions.ascProvider = teamId;
        }
        // If APP_STORE_CONNECT_PRIVATE_KEY_P8 contains the key *content*:
        // const apiKeyContent = process.env.APP_STORE_CONNECT_PRIVATE_KEY_P8;
        // if (apiKeyContent) {
        //     delete notarizeOptions.appleApiKey; // Remove path if content is provided
        //     notarizeOptions.appleApiKeyContent = apiKeyContent;
        // }

    } else if (appleId && appleIdPassword && teamId) {
        console.warn('Using legacy Apple ID and App-Specific Password for notarization. Consider migrating to API Key.');
        notarizeOptions = {
            tool: 'notarytool', // or 'altool' if notarytool fails with app-specific password
            appBundleId: appBundleId,
            appPath: appPath,
            appleId: appleId,
            appleIdPassword: appleIdPassword, // Ensure this is an APP-SPECIFIC password
            teamId: teamId,
            verbose: true,
        };
    } else {
        console.log('Skipping notarization: missing required credentials (API Key or Apple ID/Password + Team ID).');
        return;
    }

    console.log(`Notarizing app: ${appName}`);
    try {
        await notarize(notarizeOptions);
        console.log('Notarization completed successfully');
    } catch (error) {
        console.error('Notarization failed:', error);
        if (process.env.ENFORCE_NOTARIZATION === 'true') {
            throw error;
        }
    }
}