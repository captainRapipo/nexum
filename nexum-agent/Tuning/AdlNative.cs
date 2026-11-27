using System.Runtime.InteropServices;

namespace NexumAgent.Tuning;

/// <summary>
/// The ONLY native declarations of the AMD Display Library (ADL) in Nexum (CONTRACT §1.7.1).
/// <para>
/// Read-only by construction: every entry point below only reads (Create/Destroy a private ADL context, adapter
/// enumeration, Overdrive capabilities, the Overdrive8 Init/Current tables and an event counter). There is no
/// write entry point here, and CI (.github/scripts/check-tuning-readonly.mjs) fails the build if one is added,
/// if any other file under Tuning/ imports native code, or if an entry point is resolved dynamically.
/// </para>
/// <para>
/// Prototypes, structure layouts and constants follow the MIT-licensed AMD ADL SDK headers
/// (https://github.com/GPUOpen-LibrariesAndSDKs/display-library, include/adl_sdk.h, include/adl_structures.h,
/// include/adl_defines.h, and the prototypes in Public-Documents/html/overdrive8_8h_source.html,
/// overdriveN_8h_source.html, adapter_8h_source.html; master at 84c881cb2136f04287eb3af12de00a9e2867aa9e).
/// Copyright (c) 2016 - 2022 Advanced Micro Devices, Inc.; the MIT notice is in licenses/ADL/LICENSE.txt.
/// </para>
/// The library is the one installed by the AMD driver, resolved from System32 only (never shipped, never loaded
/// from another folder). x64 has a single calling convention, so the headers' __stdcall/cdecl distinction is moot.
/// </summary>
internal static class AdlNative
{
    private const string Dll = "atiadlxx.dll";

    // ── adl_defines.h ──
    public const int ADL_OK = 0;
    public const int ADL_MAX_PATH = 256;
    /// <summary>ADL_ODN_EVENTCOUNTER_VPURECOVERY.</summary>
    public const int ADL_ODN_EVENTCOUNTER_VPURECOVERY = 1;

    // enum ADLOD8FeatureControl (capability bits of ADLOD8InitSetting.overdrive8Capabilities)
    public const int ADL_OD8_GFXCLK_LIMITS = 1 << 0;
    public const int ADL_OD8_UCLK_MAX = 1 << 2;
    public const int ADL_OD8_POWER_LIMIT = 1 << 3;
    public const int ADL_OD8_FAN_ZERO_RPM_CONTROL = 1 << 9;
    public const int ADL_OD8_AUTO_UV_ENGINE = 1 << 10;
    public const int ADL_OD8_FAN_CURVE = 1 << 13;
    public const int ADL_OD8_OPTIMIZED_GPU_POWER_MODE = 1 << 16;
    public const int ADL_OD8_ODVOLTAGE_LIMIT = 1 << 17;

    // enum ADLOD8SettingId (indices into the Init/Current tables)
    public const int OD8_GFXCLK_FMAX = 0;
    public const int OD8_UCLK_FMAX = 8;
    public const int OD8_POWER_PERCENTAGE = 9;
    public const int OD8_FAN_ZERORPM_CONTROL = 15;
    public const int OD8_AUTO_UV_ENGINE_CONTROL = 16;
    public const int OD8_FAN_CURVE_TEMPERATURE_1 = 19; // TEMPERATURE_n = 19 + 2(n-1), SPEED_n = 20 + 2(n-1)
    public const int OD8_FAN_ZERO_RPM_STOP_TEMPERATURE = 35;
    public const int OD8_OPTIMZED_POWER_MODE = 36; // (sic) header spelling
    public const int OD8_OD_VOLTAGE = 37;
    public const int OD8_COUNT = 77;

    /// <summary>ADLOD8SettingId names by index (adl_defines.h), for the probe report.</summary>
    public static readonly string[] Od8SettingNames =
    {
        "OD8_GFXCLK_FMAX", "OD8_GFXCLK_FMIN", "OD8_GFXCLK_FREQ1", "OD8_GFXCLK_VOLTAGE1", "OD8_GFXCLK_FREQ2",
        "OD8_GFXCLK_VOLTAGE2", "OD8_GFXCLK_FREQ3", "OD8_GFXCLK_VOLTAGE3", "OD8_UCLK_FMAX", "OD8_POWER_PERCENTAGE",
        "OD8_FAN_MIN_SPEED", "OD8_FAN_ACOUSTIC_LIMIT", "OD8_FAN_TARGET_TEMP", "OD8_OPERATING_TEMP_MAX", "OD8_AC_TIMING",
        "OD8_FAN_ZERORPM_CONTROL", "OD8_AUTO_UV_ENGINE_CONTROL", "OD8_AUTO_OC_ENGINE_CONTROL", "OD8_AUTO_OC_MEMORY_CONTROL",
        "OD8_FAN_CURVE_TEMPERATURE_1", "OD8_FAN_CURVE_SPEED_1", "OD8_FAN_CURVE_TEMPERATURE_2", "OD8_FAN_CURVE_SPEED_2",
        "OD8_FAN_CURVE_TEMPERATURE_3", "OD8_FAN_CURVE_SPEED_3", "OD8_FAN_CURVE_TEMPERATURE_4", "OD8_FAN_CURVE_SPEED_4",
        "OD8_FAN_CURVE_TEMPERATURE_5", "OD8_FAN_CURVE_SPEED_5", "OD8_WS_FAN_AUTO_FAN_ACOUSTIC_LIMIT",
        "OD8_GFXCLK_CURVE_COEFFICIENT_A", "OD8_GFXCLK_CURVE_COEFFICIENT_B", "OD8_GFXCLK_CURVE_COEFFICIENT_C",
        "OD8_GFXCLK_CURVE_VFT_FMIN", "OD8_UCLK_FMIN", "OD8_FAN_ZERO_RPM_STOP_TEMPERATURE", "OD8_OPTIMZED_POWER_MODE",
        "OD8_OD_VOLTAGE", "OD8_ADV_OC_LIMITS_SETTING", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_1",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_2", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_3",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_4", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_5",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_POINT_6", "OD8_AUTO_CURVE_OPTIMIZER_SETTING", "OD8_GFX_VOLTAGE_LIMIT_SETTING",
        "OD8_TDC_PERCENTAGE", "OD8_FULL_CONTROL_MODE_SETTING", "OD8_FULL_CONTROL_MODE_GFXCLK", "OD8_FULL_CONTROL_MODE_UCLK",
        "OD8_IDLE_POWER_SAVING_FEATURE_CONTROL", "OD8_RUNTIME_POWER_SAVING_FEATURE_CONTROL",
        "OD8_FULL_CONTROL_MODE_FEATURE_CONTROL", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_1",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_2", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_3",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_4", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_5",
        "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_FREQ_ANCHOR_6", "OD8_PER_ZONE_GFX_VOLTAGE_OFFSET_VOLTAGE_LIMIT",
        "OD8_ACTIMING_PARAMETER_TRRDS", "OD8_ACTIMING_PARAMETER_TCL", "OD8_ACTIMING_PARAMETER_TCWL",
        "OD8_ACTIMING_PARAMETER_TRCDRD", "OD8_ACTIMING_PARAMETER_TRCDWR", "OD8_ACTIMING_PARAMETER_TRAS",
        "OD8_ACTIMING_PARAMETER_TRPAB", "OD8_ACTIMING_PARAMETER_TRFC", "OD8_ACTIMING_PARAMETER_TRFCPB",
        "OD8_ACTIMING_PARAMETER_TRREFD", "OD8_ACTIMING_PARAMETER_TREF", "OD8_ACTIMING_PARAMETER_TWR",
        "OD8_ACTIMING_PARAMETER_TWTRS", "OD8_OVERDRIVE_INTERFACE_ID", "OD8_AUTO_UV_ENGINE_V2_ID", "OD8_POWER_GAUGE",
    };

    // ── adl_structures.h ──

    /// <summary>typedef struct AdapterInfo (Windows layout, 1572 bytes).</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct AdapterInfo
    {
        public int iSize;
        public int iAdapterIndex;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strUDID;
        public int iBusNumber;
        public int iDeviceNumber;
        public int iFunctionNumber;
        public int iVendorID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strAdapterName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strDisplayName;
        public int iPresent;
        public int iExist;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strDriverPath;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strDriverPathExt;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ADL_MAX_PATH)] public string strPNPString;
        public int iOSDisplayIndex;
    }

    /// <summary>typedef struct ADLOD8SingleInitSetting { int featureID, minValue, maxValue, defaultValue; } (16 bytes).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct ADLOD8SingleInitSetting
    {
        public int featureID;
        public int minValue;
        public int maxValue;
        public int defaultValue;
    }

    /// <summary>Size of ADLOD8SingleInitSetting.</summary>
    public const int SingleInitSettingSize = 16;

    // ── adl_sdk.h: typedef void* (__stdcall *ADL_MAIN_MALLOC_CALLBACK)(int); ──
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate IntPtr AdlMainMallocCallback(int size);

    // ── Entry points (CONTRACT §1.7.1 whitelist; nothing else may be declared) ──

    // int ADL2_Main_Control_Create(ADL_MAIN_MALLOC_CALLBACK callback, int iEnumConnectedAdapters, ADL_CONTEXT_HANDLE* context);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Main_Control_Create(AdlMainMallocCallback callback, int iEnumConnectedAdapters, out IntPtr context);

    // int ADL2_Main_Control_Destroy(ADL_CONTEXT_HANDLE context);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Main_Control_Destroy(IntPtr context);

    // int ADL2_Adapter_NumberOfAdapters_Get(ADL_CONTEXT_HANDLE context, int* lpNumAdapters);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Adapter_NumberOfAdapters_Get(IntPtr context, out int lpNumAdapters);

    // int ADL2_Adapter_AdapterInfo_Get(ADL_CONTEXT_HANDLE context, LPAdapterInfo lpInfo, int iInputSize);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Adapter_AdapterInfo_Get(IntPtr context, IntPtr lpInfo, int iInputSize);

    // int ADL2_Adapter_Active_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, int* lpStatus);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Adapter_Active_Get(IntPtr context, int iAdapterIndex, out int lpStatus);

    // int ADL2_Overdrive_Caps(ADL_CONTEXT_HANDLE context, int iAdapterIndex, int* iSupported, int* iEnabled, int* iVersion);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Overdrive_Caps(IntPtr context, int iAdapterIndex, out int iSupported, out int iEnabled, out int iVersion);

    // int ADL2_Overdrive8_Init_Setting_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, ADLOD8InitSetting* lpInitSetting);
    // Caller-allocated struct; passed as a raw (oversized) buffer so a driver with a larger OD8_COUNT cannot overrun it.
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Overdrive8_Init_Setting_Get(IntPtr context, int iAdapterIndex, IntPtr lpInitSetting);

    // int ADL2_Overdrive8_Init_SettingX2_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, int* lpOverdrive8Capabilities,
    //                                        int* lpNumberOfFeatures, ADLOD8SingleInitSetting** lppInitSettingList);
    // The list is allocated through our ADL_MAIN_MALLOC_CALLBACK and freed by the caller. lpNumberOfFeatures is in/out:
    // the driver rejects a zero input (ADL_ERR_NULL_POINTER, observed on RDNA4), so it starts at OD8_COUNT as in the
    // SDK's Overdrive8 sample.
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Overdrive8_Init_SettingX2_Get(IntPtr context, int iAdapterIndex, ref int lpOverdrive8Capabilities,
        ref int lpNumberOfFeatures, ref IntPtr lppInitSettingList);

    // int ADL2_Overdrive8_Current_Setting_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, ADLOD8CurrentSetting* lpCurrentSetting);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Overdrive8_Current_Setting_Get(IntPtr context, int iAdapterIndex, IntPtr lpCurrentSetting);

    // int ADL2_Overdrive8_Current_SettingX2_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, int* lpNumberOfFeatures,
    //                                           int** lppCurrentSettingList);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_Overdrive8_Current_SettingX2_Get(IntPtr context, int iAdapterIndex, ref int lpNumberOfFeatures,
        ref IntPtr lppCurrentSettingList);

    // int ADL2_OverdriveN_CountOfEvents_Get(ADL_CONTEXT_HANDLE context, int iAdapterIndex, int eventcounterType, int* eventCount);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern int ADL2_OverdriveN_CountOfEvents_Get(IntPtr context, int iAdapterIndex, int eventcounterType, out int eventCount);
}
