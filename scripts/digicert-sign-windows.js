const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

exports.default = async function(configuration) {
  console.log(`Starting DigiCert code signing for: ${configuration.path}`);
  
  try {
    // Setup path for SMCTL config file
    const configPath = path.resolve(process.cwd(), 'pkcs11properties.cfg');
    
    // Log environment variables (without sensitive values)
    console.log('Checking environment variables...');
    console.log('SM_HOST exists:', !!process.env.SM_HOST);
    console.log('SM_API_KEY exists:', !!process.env.SM_API_KEY);
    console.log('SM_CLIENT_CERT_FILE exists:', !!process.env.SM_CLIENT_CERT_FILE);
    console.log('SM_CLIENT_CERT_PASSWORD exists:', !!process.env.SM_CLIENT_CERT_PASSWORD);
    console.log('SM_CODE_SIGNING_CERT_SHA1_HASH exists:', !!process.env.SM_CODE_SIGNING_CERT_SHA1_HASH);
    
    // Check if configuration path exists
    console.log('Config file exists:', fs.existsSync(configPath));
    
    // Run the signing command
    const cmd = `smctl sign --fingerprint "${process.env.SM_CODE_SIGNING_CERT_SHA1_HASH}" --input "${configuration.path}" --config-file "${configPath}"`;
    console.log(`Executing command: ${cmd}`);
    
    execSync(cmd, { stdio: 'inherit' });
    
    console.log(`Successfully signed: ${configuration.path}`);
    return true;
  } catch (error) {
    console.error('Error during DigiCert code signing:', error.message);
    throw error;
  }
} 