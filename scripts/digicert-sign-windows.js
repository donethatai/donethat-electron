const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
    
    // Run healthcheck
    try {
      console.log('Running SMCTL healthcheck...');
      const healthCheckOutput = execSync('smctl healthcheck', { encoding: 'utf8' });
      console.log('Healthcheck output:', healthCheckOutput);
    } catch (healthcheckError) {
      console.error('Healthcheck failed:', healthcheckError.message);
      if (healthcheckError.stdout) console.log('Healthcheck stdout:', healthcheckError.stdout);
      if (healthcheckError.stderr) console.log('Healthcheck stderr:', healthcheckError.stderr);
    }
    
    // Try to get keypair alias as a fallback
    let keypairAlias = '';
    try {
      console.log('Looking for available keypairs...');
      const keypairsOutput = execSync('smctl keypair list', { encoding: 'utf8' });
      console.log('Keypairs output:', keypairsOutput);
      
      // Try to extract first keypair alias from output
      const match = keypairsOutput.match(/\|\s+(\w+)\s+\|/);
      if (match && match[1]) {
        keypairAlias = match[1];
        console.log(`Found keypair alias: ${keypairAlias}`);
      }
    } catch (keypairError) {
      console.error('Failed to list keypairs:', keypairError.message);
      if (keypairError.stdout) console.log('Keypair list stdout:', keypairError.stdout);
      if (keypairError.stderr) console.log('Keypair list stderr:', keypairError.stderr);
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
          console.log('SMCTL log file contents:', logContent);
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
        }
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