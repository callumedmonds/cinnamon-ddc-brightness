/* Parser tests for the DDC Brightness applet.
 * Run with ./run-tests.sh — fixtures are real ddcutil output captured from an
 * MSI MP275 and an iiyama PL2730H behind the NVIDIA proprietary driver, whose
 * connector-lookup warnings are part of what the parsers must survive.
 *
 * SPDX-License-Identifier: MIT */
const GLib = imports.gi.GLib;
const read = (p) => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
eval(read(ARGV[0]));

let failures = 0;
function check(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { print("  PASS  " + name); return; }
    failures++;
    print("  FAIL  " + name + "\n          got  " + g + "\n          want " + w);
}
const fixture = (n) => read("fixtures/" + n);

print("parseDetect — real output, NVIDIA warning noise included");
check("finds both monitors", parseDetect(fixture("detect-nvidia.txt")),
      [{bus:7,model:"MSI MP275"},{bus:8,model:"PL2730H"}]);
check("display with no Monitor line falls back to bus",
      parseDetect("Display 1\n   I2C bus:  /dev/i2c-3\n"), [{bus:3,model:"Display 3"}]);
check("no displays", parseDetect("junk\nmore junk\n"), []);
check("Invalid display contributes nothing",
      parseDetect("Invalid display\n   I2C bus:  /dev/i2c-4\n   Monitor:  X:Ghost:1\n"), []);
check("Phantom display ignored, real one kept",
      parseDetect("Phantom display\n   I2C bus:  /dev/i2c-4\nDisplay 1\n   I2C bus:  /dev/i2c-7\n   Monitor:  MSI:MSI MP275:P1\n"),
      [{bus:7,model:"MSI MP275"}]);
check("invalid block cannot bleed its bus into the block before it",
      parseDetect("Display 1\n   Monitor:  A:PanelOne:1\n   I2C bus:  /dev/i2c-7\nInvalid display\n   I2C bus:  /dev/i2c-99\n"),
      [{bus:7,model:"PanelOne"}]);

print("parseVcpLine — continuous and non-continuous forms");
const c = parseVcpLine(fixture("getvcp-10-continuous.txt"), "10");
check("continuous recognised", c !== null && c.continuous, true);
check("max read from the wire", c && c.max, 100);
const e = parseVcpLine(fixture("getvcp-14-enum.txt"), "14");
check("non-continuous recognised", e !== null && e.continuous === false, true);
check("CNC current value is the LAST field", e && e.value, 5);
check("SNC short form", parseVcpLine("VCP 14 SNC x0b\n", "14"), {continuous:false,value:11,max:0});
check("other code -> null", parseVcpLine("VCP 10 C 50 100\n", "12"), null);
check("empty -> null", parseVcpLine("", "10"), null);
check("max of zero rejected", parseVcpLine("VCP 10 C 50 0\n", "10"), null);
check("max other than 100 preserved", parseVcpLine("VCP 10 C 128 255\n", "10"),
      {continuous:true,value:128,max:255});

print("parseColorPresets — Kelvin entries only, sorted");
check("MSI: User 1 dropped", parseColorPresets(fixture("capabilities-bus7.txt")),
      [{raw:4,label:"5000 K",kelvin:5000},{raw:5,label:"6500 K",kelvin:6500},{raw:8,label:"9300 K",kelvin:9300}]);
check("iiyama: different preset set", parseColorPresets(fixture("capabilities-bus8.txt")),
      [{raw:5,label:"6500 K",kelvin:6500},{raw:6,label:"7500 K",kelvin:7500},{raw:8,label:"9300 K",kelvin:9300}]);
check("fewer than two Kelvin values yields none",
      parseColorPresets("   Feature: 14 (Select color preset)\n      Values:\n         0b: User 1\n"), []);
check("another feature's value list is not absorbed",
      parseColorPresets("   Feature: CC (OSD Language)\n         02: English\n   Feature: 14 (x)\n         05: 6500 K\n"),
      [{raw:5,label:"6500 K",kelvin:6500}]);

print(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
if (failures > 0) imports.system.exit(1);
