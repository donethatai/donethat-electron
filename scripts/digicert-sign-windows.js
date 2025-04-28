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
      console.log('Healthcheck output (last 20 lines):\n', getLastNLines(healthCheckOutput));
    } catch (healthcheckError) {
      console.error('Healthcheck failed:', healthcheckError.message);
      if (healthcheckError.stdout) console.log('Healthcheck stdout (last 20 lines):\n', getLastNLines(healthcheckError.stdout));
      if (healthcheckError.stderr) console.log('Healthcheck stderr (last 20 lines):\n', getLastNLines(healthcheckError.stderr));
    }
    
    // Try to get keypair alias as a fallback
    let keypairAlias = '';
    try {
      console.log('Looking for available keypairs...');
      const keypairsOutput = execSync('smctl keypair list', { encoding: 'utf8' });
      console.log('Keypairs output (last 20 lines):\n', getLastNLines(keypairsOutput));
      
      // Try to extract first keypair alias from output
      const match = keypairsOutput.match(/\|\s+(\w+)\s+\|/);
      if (match && match[1]) {
        keypairAlias = match[1];
        console.log(`Found keypair alias: ${keypairAlias}`);
      }
    } catch (keypairError) {
      console.error('Failed to list keypairs:', keypairError.message);
      if (keypairError.stdout) console.log('Keypair list stdout (last 20 lines):\n', getLastNLines(keypairError.stdout));
      if (keypairError.stderr) console.log('Keypair list stderr (last 20 lines):\n', getLastNLines(keypairError.stderr));
    }

    // List certificates in store
    try {
      console.log('Listing certificates in store...');
      const certListOutput = execSync('certutil -store -user My', { encoding: 'utf8' });
      console.log('Certificate store contents (last 20 lines):\n', getLastNLines(certListOutput));
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
      console.log('Signing output (last 20 lines):\n', getLastNLines(output));
      
      // Check if output contains "FAILED"
      if (output.includes('FAILED')) {
        throw new Error('Signing failed - output indicates failure');
      }
      success = true;
    } catch (error) {
      console.error('Fingerprint signing failed:', error.message);
      if (error.stdout) console.log('Command stdout (last 20 lines):\n', getLastNLines(error.stdout));
      if (error.stderr) console.log('Command stderr (last 20 lines):\n', getLastNLines(error.stderr));
      
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
      if (keypairAlias) {
        try {
          console.log(`Attempt 2: Signing with keypair alias: ${keypairAlias}...`);
          const cmd = `smctl sign --keypair-alias ${keypairAlias} --input "${configuration.path}" --config-file "${pkcs11ConfigPath}"`;
          console.log(`Executing command: ${cmd}`);
          
          const output = execSync(cmd, { encoding: 'utf8' });
          console.log('Signing output (last 20 lines):\n', getLastNLines(output));
          
          // Check if output contains "FAILED"
          if (output.includes('FAILED')) {
            throw new Error('Signing failed - output indicates failure');
          }
          success = true;
        } catch (aliasError) {
          console.error('Keypair alias signing failed:', aliasError.message);
          if (aliasError.stdout) console.log('Command stdout (last 20 lines):\n', getLastNLines(aliasError.stdout));
          if (aliasError.stderr) console.log('Command stderr (last 20 lines):\n', getLastNLines(aliasError.stderr));
        }
      }

      // Attempt 3: Try with direct certificate file
      if (process.env.SM_CLIENT_CERT_FILE && fs.existsSync(process.env.SM_CLIENT_CERT_FILE)) {
        try {
          console.log('Attempt 3: Signing with direct certificate file...');
          const cmd = `smctl sign --cert-file "${process.env.SM_CLIENT_CERT_FILE}" --cert-password "${process.env.SM_CLIENT_CERT_PASSWORD}" --input "${configuration.path}" --config-file "${pkcs11ConfigPath}"`;
          console.log(`Executing command: ${cmd.replace(process.env.SM_CLIENT_CERT_PASSWORD, '***')}`);
          
          const output = execSync(cmd, { encoding: 'utf8' });
          console.log('Signing output (last 20 lines):\n', getLastNLines(output));
          
          if (output.includes('FAILED')) {
            throw new Error('Signing failed - output indicates failure');
          }
          success = true;
        } catch (certFileError) {
          console.error('Certificate file signing failed:', certFileError.message);
          if (certFileError.stdout) console.log('Command stdout (last 20 lines):\n', getLastNLines(certFileError.stdout));
          if (certFileError.stderr) console.log('Command stderr (last 20 lines):\n', getLastNLines(certFileError.stderr));
        }
      }
    }
    
    // Verify the signature if signing succeeded
    if (success) {
      try {
        console.log('Verifying signature...');
        const verifyCmd = `smctl sign verify --input "${configuration.path}"`;
        const verifyOutput = execSync(verifyCmd, { encoding: 'utf8' });
        console.log('Verification output (last 20 lines):\n', getLastNLines(verifyOutput));
        
        // Check if verification failed
        if (verifyOutput.includes('FAILED') || verifyOutput.includes('No signature found')) {
          throw new Error('Signature verification failed');
        }
      } catch (verifyError) {
        console.error('Verification failed:', verifyError.message);
        if (verifyError.stdout) console.log('Verify stdout (last 20 lines):\n', getLastNLines(verifyError.stdout));
        if (verifyError.stderr) console.log('Verify stderr (last 20 lines):\n', getLastNLines(verifyError.stderr));
        success = false;
      }
    }
    
    if (!success) {
      console.error('All signing attempts failed');
      return false; // Return false to indicate signing failure
    }
    
    console.log(`Successfully signed: ${configuration.path}`);
    return true;
  } catch (error) {
    console.error('Error during DigiCert code signing:', error.message);
    return false; // Return false to indicate signing failure
  }
} 