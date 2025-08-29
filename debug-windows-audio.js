const audioSessionDetector = require('./src-main/audioSessionDetector');

async function debugWindowsAudioDetection() {
  console.log('=== Windows Audio Detection Debug ===\n');

  // Check if we're on Windows
  if (process.platform !== 'win32') {
    console.log('This script is designed for Windows. Current platform:', process.platform);
    return;
  }

  console.log('Platform:', process.platform);
  console.log('Current Windows detection config:', audioSessionDetector.getWindowsDetectionConfig());

  // Test individual detection methods
  console.log('\n=== Testing Individual Methods ===');
  
  try {
    const result = await audioSessionDetector.detectWindowsMicrophoneUsage();
    console.log('Detection result:', result);
  } catch (error) {
    console.error('Detection error:', error.message);
  }

  // Test microphone usage detection
  console.log('\n=== Testing Microphone Usage Detection ===');
  
  try {
    const usage = await audioSessionDetector.detectMicrophoneUsage();
    console.log('Microphone usage:', usage);
  } catch (error) {
    console.error('Usage detection error:', error.message);
  }

  // Test with different configurations
  console.log('\n=== Testing with Different Configurations ===');
  
  // Test with only process method
  audioSessionDetector.configureWindowsDetection({
    enableRegistryMethod: false,
    enableProcessMethod: true,
    enableDeviceMethod: false,
    enablePrivacyMethod: false,
    enableNonPackagedMethod: false,
    enableWindowActivityMethod: false
  });
  
  try {
    const processResult = await audioSessionDetector.detectWindowsMicrophoneUsage();
    console.log('Process-only detection result:', processResult);
  } catch (error) {
    console.error('Process-only detection error:', error.message);
  }

  // Test with only registry method
  audioSessionDetector.configureWindowsDetection({
    enableRegistryMethod: true,
    enableProcessMethod: false,
    enableDeviceMethod: false,
    enablePrivacyMethod: false,
    enableNonPackagedMethod: false,
    enableWindowActivityMethod: false
  });
  
  try {
    const registryResult = await audioSessionDetector.detectWindowsMicrophoneUsage();
    console.log('Registry-only detection result:', registryResult);
  } catch (error) {
    console.error('Registry-only detection error:', error.message);
  }

  // Reset to default configuration
  audioSessionDetector.configureWindowsDetection({
    enableRegistryMethod: true,
    enableProcessMethod: true,
    enableDeviceMethod: true,
    enablePrivacyMethod: true,
    enableNonPackagedMethod: true,
    enableWindowActivityMethod: true
  });

  console.log('\n=== Debug Complete ===');
}

// Run the debug function
debugWindowsAudioDetection().catch(console.error);
