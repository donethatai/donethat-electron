exports.default = async function(configuration) {
    // do not include passwords or other sensitive data in the file
    // rather create environment variables with sensitive data
    const CERTIFICATE_NAME = process.env.WINDOWS_SIGN_CERTIFICATE_NAME;
    const API_KEY = process.env.SM_API_KEY;
    const CLIENT_CERT_FILE = process.env.SM_CLIENT_CERT_FILE;
    const CLIENT_CERT_PASSWORD = process.env.SM_CLIENT_CERT_PASSWORD;

    // Create PKCS11 configuration file
    const fs = require('fs');
    const path = require('path');
    const pkcs11Config = `name=signingmanager
library=C:\\Program Files\\DigiCert\\DigiCert Keylocker Tools\\smpkcs11.dll
slotListIndex=0`;
    
    const configPath = path.join(process.cwd(), 'pkcs11properties.cfg');
    fs.writeFileSync(configPath, pkcs11Config);

    // Sign using jarsigner
    require("child_process").execSync(
        `jarsigner -keystore NONE -storepass NONE -storetype PKCS11 -sigalg SHA256withRSA -providerClass sun.security.pkcs11.SunPKCS11 -providerArg "${configPath}" -signedjar "${configuration.path}" "${configuration.path}" "${CERTIFICATE_NAME}" -tsa http://timestamp.digicert.com`,
        {
            stdio: "inherit",
            env: {
                ...process.env,
                SM_API_KEY: API_KEY,
                SM_CLIENT_CERT_FILE: CLIENT_CERT_FILE,
                SM_CLIENT_CERT_PASSWORD: CLIENT_CERT_PASSWORD
            }
        }
    );

    // Verify signature
    require("child_process").execSync(
        `jarsigner -verify "${configuration.path}"`,
        {
            stdio: "inherit"
        }
    );
};