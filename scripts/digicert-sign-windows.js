const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Helper function to get last N lines of output
function getLastNLines(output, n = 20) {
  if (!output) return '';
  const lines = output.split('\n');
  return lines.slice(-n).join('\n');
}

// Helper function to setup local certificate
function setupLocalCertificate() {
  const projectRoot = process.cwd();
  const certPath = path.join(projectRoot, 'Certificate_pkcs12.p12');
  const configPath = path.join(projectRoot, 'pkcs11properties.cfg');
  
  // Check if certificate exists
  if (!fs.existsSync(certPath)) {
    throw new Error('Certificate file not found. Please place your certificate at: ' + certPath);
  }
  
  // Create config file if it doesn't exist
  if (!fs.existsSync(configPath)) {
    const configContent = `[PKCS11]
library=C:\\Program Files\\DigiCert\\DigiCert One Signing Manager Tools\\smctlsign.dll
slot=0
password=${process.env.SM_CLIENT_CERT_PASSWORD || ''}`;
    
    fs.writeFileSync(configPath, configContent);
  }

  // Set required environment variables
  process.env.SM_CLIENT_CERT_FILE = certPath;
  process.env.SM_CLIENT_CERT_PASSWORD = process.env.SM_CLIENT_CERT_PASSWORD || '';
  process.env.SM_KEYPAIR_ALIAS = process.env.SM_KEYPAIR_ALIAS || '';
  
  return {
    certPath,
    configPath
  };
}

exports.default = async function(configuration) {
  try {
    // Determine if we're running in GitHub Actions or locally
    const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
    
    let pkcs11ConfigPath;
    let smctlLogPath;
    
    if (isGitHubActions) {
      // GitHub Actions paths
      pkcs11ConfigPath = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\smtools-windows-x64\\pkcs11properties.cfg';
      smctlLogPath = 'C:\\Users\\RUNNER~1\\.signingmanager\\logs\\smctl.log';
    } else {
      // Local paths
      const { configPath } = setupLocalCertificate();
      pkcs11ConfigPath = configPath;
      smctlLogPath = path.join(os.homedir(), '.signingmanager', 'logs', 'smctl.log');
      
      // Set PATH to include signtools
      const signtoolsPath = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x86';
      process.env.PATH = `${signtoolsPath};${process.env.PATH}`;

      // Create .signingmanager directory if it doesn't exist
      const signingManagerDir = path.join(os.homedir(), '.signingmanager', 'logs');
      if (!fs.existsSync(signingManagerDir)) {
        fs.mkdirSync(signingManagerDir, { recursive: true });
      }

      // Sync certificate first (only in local environment)
      try {
        const syncCmd = `smctl windows certsync --keypair-alias=${process.env.SM_KEYPAIR_ALIAS}`;
        const syncOutput = execSync(syncCmd, { encoding: 'utf8' });
        
        if (syncOutput.includes('FAILED')) {
          throw new Error('Certificate sync failed - output indicates failure');
        }
      } catch (syncError) {
        console.error('Certificate sync failed:', syncError.message);
        if (syncError.stderr) console.error('Sync stderr:', syncError.stderr);
        throw new Error('Build failed: Certificate sync failed');
      }
    }
    
    if (!process.env.SM_KEYPAIR_ALIAS) {
      throw new Error('Build failed: SM_KEYPAIR_ALIAS environment variable is not set');
    }

    // Sign with keypair alias
    try {
      const cmd = `smctl sign --keypair-alias ${process.env.SM_KEYPAIR_ALIAS} --input "${configuration.path}" --config-file "${pkcs11ConfigPath}"`;
      const output = execSync(cmd, { encoding: 'utf8' });
      
      if (output.includes('FAILED')) {
        throw new Error('Signing failed - output indicates failure');
      }
    } catch (signingError) {
      console.error('Signing failed:', signingError.message);
      if (signingError.stderr) console.error('Signing stderr:', signingError.stderr);
      
      // Read and log SMCTL log file if it exists
      if (fs.existsSync(smctlLogPath)) {
        try {
          const logContent = fs.readFileSync(smctlLogPath, 'utf8');
          console.error('SMCTL log file contents (last 20 lines):\n', getLastNLines(logContent));
        } catch (logError) {
          console.error('Failed to read SMCTL log file:', logError.message);
        }
      }
      
      throw new Error('Build failed: Signing failed');
    }
    
    // Verify the signature
    try {
      const verifyCmd = `smctl sign verify --input "${configuration.path}"`;
      const verifyOutput = execSync(verifyCmd, { encoding: 'utf8' });
      
      if (verifyOutput.includes('FAILED') || verifyOutput.includes('No signature found')) {
        throw new Error('Signature verification failed');
      }
    } catch (verifyError) {
      console.error('Verification failed:', verifyError.message);
      if (verifyError.stderr) console.error('Verify stderr:', verifyError.stderr);
      
      // Read and log SMCTL log file if it exists
      if (fs.existsSync(smctlLogPath)) {
        try {
          const logContent = fs.readFileSync(smctlLogPath, 'utf8');
          console.error('SMCTL log file contents (last 20 lines):\n', getLastNLines(logContent));
        } catch (logError) {
          console.error('Failed to read SMCTL log file:', logError.message);
        }
      }
      
      throw new Error('Build failed: Signature verification failed');
    }
    
    return true;
  } catch (error) {
    throw error; // Re-throw the error to ensure the pipeline fails
  }
} 