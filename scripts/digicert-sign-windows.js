const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Helper function to get last N lines of output
function getLastNLines(output, n = 20) {
  if (!output) return '';
  const lines = output.split('\n');
  return lines.slice(-n).join('\n');
}

exports.default = async function(configuration) {
  console.log(`Starting DigiCert code signing for: ${configuration.path}`);
  
  try {
    // DigiCert tools creates this configuration file automatically
    const pkcs11ConfigPath = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\smtools-windows-x64\\pkcs11properties.cfg';
    const smctlLogPath = 'C:\\Users\\RUNNER~1\\.signingmanager\\logs\\smctl.log';
    
    // Log environment variables (without sensitive values)
    console.log('Checking environment variables...');
    console.log('SM_HOST exists:', !!process.env.SM_HOST);
    console.log('SM_API_KEY exists:', !!process.env.SM_API_KEY);
    console.log('SM_CLIENT_CERT_FILE exists:', !!process.env.SM_CLIENT_CERT_FILE);
    console.log('SM_CLIENT_CERT_PASSWORD exists:', !!process.env.SM_CLIENT_CERT_PASSWORD);
    console.log('SM_CODE_SIGNING_CERT_SHA1_HASH exists:', !!process.env.SM_CODE_SIGNING_CERT_SHA1_HASH);
    console.log('SM_KEYPAIR_ALIAS exists:', !!process.env.SM_KEYPAIR_ALIAS);
    
    // Check if configuration path exists
    console.log('PKCS11 config file exists:', fs.existsSync(pkcs11ConfigPath));
    
    // Check certificate file
    if (process.env.SM_CLIENT_CERT_FILE) {
      console.log('Certificate file exists:', fs.existsSync(process.env.SM_CLIENT_CERT_FILE));
      if (fs.existsSync(process.env.SM_CLIENT_CERT_FILE)) {
        const stats = fs.statSync(process.env.SM_CLIENT_CERT_FILE);
        console.log('Certificate file size:', stats.size, 'bytes');
      }
    }
    
    // Run healthcheck
    try {
      console.log('Running SMCTL healthcheck...');
      const healthCheckOutput = execSync('smctl healthcheck', { encoding: 'utf8' });
      console.log('Healthcheck output:', healthCheckOutput);
    } catch (healthcheckError) {
      console.error('Healthcheck failed:', healthcheckError.message);
      if (healthcheckError.stdout) console.log('Healthcheck stdout:', healthcheckError.stdout);
      if (healthcheckError.stderr) console.log('Healthcheck stderr:', healthcheckError.stderr);
      throw new Error('Build failed: Healthcheck failed');
    }

    // List certificates in store
    try {
      console.log('Listing certificates in store...');
      const certListOutput = execSync('certutil -store -user My', { encoding: 'utf8' });
      console.log('Certificate store contents:', certListOutput);
    } catch (certListError) {
      console.error('Failed to list certificates:', certListError.message);
    }

    // Attempt 1: Sign with certificate fingerprint
    let success = false;
    try {
      console.log('Attempt 1: Signing with certificate fingerprint...');
      const cmd = `smctl sign --fingerprint "${process.env.SM_CODE_SIGNING_CERT_SHA1_HASH}" --input "${configuration.path}" --config-file "${pkcs11ConfigPath}"`;
      console.log(`Executing command: ${cmd.replace(process.env.SM_CODE_SIGNING_CERT_SHA1_HASH, '***')}`);
      
      const output = execSync(cmd, { encoding: 'utf8' });
      console.log('Signing output:', output);
      
      // Check if output contains "FAILED"
      if (output.includes('FAILED')) {
        throw new Error('Signing failed - output indicates failure');
      }
      success = true;
    } catch (error) {
      console.error('Fingerprint signing failed:', error.message);
      if (error.stdout) console.log('Command stdout:', error.stdout);
      if (error.stderr) console.log('Command stderr:', error.stderr);
      
      // Read and log SMCTL log file if it exists
      if (fs.existsSync(smctlLogPath)) {
        try {
          const logContent = fs.readFileSync(smctlLogPath, 'utf8');
          console.log('SMCTL log file contents (last 20 lines):\n', getLastNLines(logContent));
        } catch (logError) {
          console.error('Failed to read SMCTL log file:', logError.message);
        }
      }
      
      // Attempt 2: Try with keypair alias if available
      if (process.env.SM_KEYPAIR_ALIAS) {
        try {
          console.log(`Attempt 2: Signing with keypair alias: ${process.env.SM_KEYPAIR_ALIAS}...`);
          const cmd = `smctl sign --keypair-alias ${process.env.SM_KEYPAIR_ALIAS} --input "${configuration.path}" --config-file "${pkcs11ConfigPath}"`;
          console.log(`Executing command: ${cmd}`);
          
          const output = execSync(cmd, { encoding: 'utf8' });
          console.log('Signing output:', output);
          
          // Check if output contains "FAILED"
          if (output.includes('FAILED')) {
            throw new Error('Signing failed - output indicates failure');
          }
          success = true;
        } catch (aliasError) {
          console.error('Keypair alias signing failed:', aliasError.message);
          if (aliasError.stdout) console.log('Command stdout:', aliasError.stdout);
          if (aliasError.stderr) console.log('Command stderr:', aliasError.stderr);
          
          // Both attempts failed, stop the build
          throw new Error('Build failed: Both signing attempts failed');
        }
      } else {
        // No keypair alias available, stop the build
        throw new Error('Build failed: No keypair alias available for second attempt');
      }
    }
    
    // Verify the signature if signing succeeded
    if (success) {
      try {
        console.log('Verifying signature...');
        const verifyCmd = `smctl sign verify --input "${configuration.path}"`;
        const verifyOutput = execSync(verifyCmd, { encoding: 'utf8' });
        console.log('Verification output:', verifyOutput);
        
        // Check if verification failed
        if (verifyOutput.includes('FAILED') || verifyOutput.includes('No signature found')) {
          throw new Error('Signature verification failed');
        }
      } catch (verifyError) {
        console.error('Verification failed:', verifyError.message);
        if (verifyError.stdout) console.log('Verify stdout:', verifyError.stdout);
        if (verifyError.stderr) console.log('Verify stderr:', verifyError.stderr);
        throw new Error('Build failed: Signature verification failed');
      }
    }
    
    console.log(`Successfully signed: ${configuration.path}`);
    return true;
  } catch (error) {
    console.error('Error during DigiCert code signing:', error.message);
    throw error; // Re-throw the error to ensure the pipeline fails
  }
} 