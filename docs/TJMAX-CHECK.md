# CPU temperature limits: source check

CONTRACT §2.10.2 requires every row of the per-model CPU limit table (used by the v1.1 alert engine,
`src-tauri/src/alerts.rs`) to be re-checked on amd.com before release, with the date recorded here (ROADMAP Q9).

**Checked: 2026-11-27.** Value read: "Max. Operating Temperature (Tjmax)" in the Specifications section of AMD's
product page for each model.

| Token | CPU | Tjmax on amd.com | Contract table | Match | Page |
| --- | --- | --- | --- | --- | --- |
| `5600X` | Ryzen 5 5600X | 95 °C | 95 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-5-5600x.html) |
| `5800X` | Ryzen 7 5800X | 90 °C | 90 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-7-5800x.html) |
| `5900X` | Ryzen 9 5900X | 90 °C | 90 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-9-5900x.html) |
| `5950X` | Ryzen 9 5950X | 90 °C | 90 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-9-5950x.html) |
| `5800X3D` | Ryzen 7 5800X3D | 90 °C | 90 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-7-5800x3d.html) |
| `5700X3D` | Ryzen 7 5700X3D | 90 °C | 90 | yes | [amd.com (drivers & support page; the product URL pattern returns 404)](https://www.amd.com/en/support/downloads/drivers.html/processors/ryzen/ryzen-5000-series/amd-ryzen-7-5700x3d.html) |
| `7800X3D` | Ryzen 7 7800X3D | 89 °C | 89 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-7-7800x3d.html) |
| `7950X` | Ryzen 9 7950X | 95 °C | 95 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-9-7950x.html) |
| `9800X3D` | Ryzen 7 9800X3D | 95 °C | 95 | yes | [amd.com](https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-7-9800x3d.html) |

All nine rows match. This closes ROADMAP Q9 for the 5700X3D (the page that timed out during research reports 90 °C).

Notes:

* Models not in the table use the conservative 90 °C default, and the alert text and Settings say so.
* The agent's fan thermal override (CONTRACT §1.5.2) stays at a fixed 85 °C, independent of this table.
* Re-check before each release that changes the table, and update the date above and in the README.
