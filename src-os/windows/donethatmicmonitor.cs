using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace DoneThatMicMonitor
{
    class Program
    {
        static readonly string[] MicConsentRoots = new[]
        {
            @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        };

        static void Main(string[] args)
        {
            try
            {
                var sessions = GetActiveAudioSessions();
                var json = JsonSerializer.Serialize(sessions, new JsonSerializerOptions { WriteIndented = true });
                Console.WriteLine(json);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                Console.WriteLine("[]");
            }
        }

        static List<AudioSessionInfo> GetActiveAudioSessions()
        {
            var activeSessions = new List<AudioSessionInfo>();
            var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var rootPath in MicConsentRoots)
            {
                RegistryKey root = null;
                try
                {
                    root = Registry.CurrentUser.OpenSubKey(rootPath);
                    if (root == null) continue;

                    CollectActiveRegistrySessions(root, activeSessions, seenNames, 0);
                }
                catch
                {
                    // Continue to next root
                }
                finally
                {
                    if (root != null)
                    {
                        root.Close();
                    }
                }
            }

            return activeSessions;
        }

        static void CollectActiveRegistrySessions(RegistryKey key, List<AudioSessionInfo> activeSessions, HashSet<string> seenNames, int depth)
        {
            if (key == null) return;
            if (depth > 4) return;

            try
            {
                if (IsMicSessionActive(key))
                {
                    string fullName = key.Name ?? string.Empty;
                    string leafName = fullName;
                    try
                    {
                        leafName = Path.GetFileName(fullName);
                    }
                    catch {}

                    if (string.IsNullOrWhiteSpace(leafName))
                    {
                        leafName = fullName;
                    }

                    if (!string.IsNullOrWhiteSpace(leafName) && seenNames.Add(leafName))
                    {
                        activeSessions.Add(new AudioSessionInfo
                        {
                            pid = -1,
                            name = leafName,
                            isActive = true
                        });
                    }
                }

                var subKeyNames = key.GetSubKeyNames();
                foreach (var subKeyName in subKeyNames)
                {
                    RegistryKey subKey = null;
                    try
                    {
                        subKey = key.OpenSubKey(subKeyName);
                        if (subKey != null)
                        {
                            CollectActiveRegistrySessions(subKey, activeSessions, seenNames, depth + 1);
                        }
                    }
                    catch
                    {
                        // Ignore and continue
                    }
                    finally
                    {
                        if (subKey != null)
                        {
                            subKey.Close();
                        }
                    }
                }
            }
            catch
            {
                // Ignore and continue
            }
        }

        static bool IsMicSessionActive(RegistryKey key)
        {
            if (key == null) return false;

            try
            {
                object rawStop = key.GetValue("LastUsedTimeStop");
                if (rawStop == null) return false;

                if (rawStop is long l) return l == 0;
                if (rawStop is int i) return i == 0;
                if (rawStop is short s) return s == 0;
                if (rawStop is byte[] bytes)
                {
                    if (bytes.Length == 0) return false;
                    foreach (var b in bytes)
                    {
                        if (b != 0) return false;
                    }
                    return true;
                }

                var asText = rawStop.ToString();
                if (string.IsNullOrWhiteSpace(asText)) return false;
                if (long.TryParse(asText.Trim(), out var parsed)) return parsed == 0;
                return false;
            }
            catch
            {
                return false;
            }
        }
    }

    public class AudioSessionInfo
    {
        public int pid { get; set; }
        public string name { get; set; }
        public bool isActive { get; set; }
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out object ppDevices);
        [return: MarshalAs(UnmanagedType.Interface)]
        IMMDevice GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role);
        void GetDevice(string pwstrId, out IMMDevice ppDevice);
        void RegisterEndpointNotificationCallback(object pClient);
        void UnregisterEndpointNotificationCallback(object pClient);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [return: MarshalAs(UnmanagedType.Interface)]
        object Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, uint dwClsCtx, IntPtr pActivationParams);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC2-33261279C942")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        [return: MarshalAs(UnmanagedType.Interface)]
        object GetAudioSessionControl([MarshalAs(UnmanagedType.LPStruct)] Guid AudioSessionGuid, uint StreamFlags);
        [return: MarshalAs(UnmanagedType.Interface)]
        IAudioSessionEnumerator GetSessionEnumerator();
    }

    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        int GetCount();
        [return: MarshalAs(UnmanagedType.Interface)]
        IAudioSessionControl GetSession(int SessionCount);
    }

    [ComImport]
    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl
    {
        AudioSessionState GetState();
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetDisplayName();
    }

    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C647F13F74")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2 : IAudioSessionControl
    {
        new AudioSessionState GetState();
        [return: MarshalAs(UnmanagedType.LPWStr)]
        new string GetDisplayName();

        [return: MarshalAs(UnmanagedType.LPStr)]
        string GetSessionIdentifier();
        [return: MarshalAs(UnmanagedType.LPStr)]
        string GetSessionInstanceIdentifier();
        int GetProcessId();
        bool IsSystemSoundsSession();
    }

    internal enum EDataFlow
    {
        eRender,
        eCapture,
        eAll,
        EDataFlow_enum_count
    }

    internal enum ERole
    {
        eConsole,
        eMultimedia,
        eCommunications,
        ERole_enum_count
    }

    internal enum AudioSessionState
    {
        AudioSessionStateInactive = 0,
        AudioSessionStateActive = 1,
        AudioSessionStateExpired = 2
    }
}
