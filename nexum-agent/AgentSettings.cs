using LibreHardwareMonitor.Hardware;

namespace NexumAgent;

/// <summary>
/// In-memory LHM settings, identical to LHM's default <c>Computer.Settings</c> (nothing is stored)
/// except for one fan-safety detail: the initial software value of every fan control is 100%.
/// <para>
/// LHM's <c>Control</c> starts with <c>SoftwareValue = settings["…/control/value"] ?? 0</c>, and
/// <c>SetSoftware(x)</c> first switches the mode (writing that initial value to the PWM register) and
/// only then writes x. With the default 0, the first manual write of a session briefly commands 0%
/// (fan stop) before the real duty; if the second write were dropped the fan would stay stopped.
/// Starting from 100% makes that transient (and any dropped follow-up write) a full-speed one.
/// The control mode key is never answered here, so controls still start in <c>Undefined</c> mode and
/// LHM writes nothing at construction.
/// </para>
/// </summary>
internal sealed class AgentSettings : ISettings
{
    private const string ControlValueSuffix = "/control/value";

    public bool Contains(string name) => false;

    public void SetValue(string name, string value) { }

    public string GetValue(string name, string value) =>
        name is not null && name.EndsWith(ControlValueSuffix, StringComparison.OrdinalIgnoreCase) ? "100" : value;

    public void Remove(string name) { }
}
