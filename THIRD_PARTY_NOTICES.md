# Credits, third-party notices, and use disclaimer

## LibreEcho website

Unless a file or component says otherwise, the original website source and
original artwork in this repository are Copyright (c) 2026 LibreEcho
contributors and are available under the MIT License in [`LICENSE`](LICENSE).

That license applies only to this website repository. It does **not** relicense
third-party software, firmware, Linux kernel code, device images, protocols,
trademarks, or other material used by the wider LibreEcho project.

## Amazon Echo and MediaTek research

The wider LibreEcho development work draws on publicly available reverse-
engineering and device-enablement work. These projects are acknowledged here
as upstream research and tooling; this website repository does not claim their
work as LibreEcho code.

- [Amonet](https://github.com/xyzz/amonet) — MediaTek BootROM exploit research
  and exploit-chain foundations.
- [R0rt1z2/amonet](https://github.com/R0rt1z2/amonet) — Amazon and MediaTek
  BootROM/LK exploit-chain work.
- [k4y0z](https://github.com/k4y0z) — Amazon/MediaTek exploit, bootloader, and
  device research.
- [mtkclient](https://github.com/bkerler/mtkclient) — MediaTek communication,
  flashing, and payload infrastructure. The related LibreEcho development
  notes specifically identify `generic_stage1.c` as being adapted from
  mtkclient and credit B. Kerler and k4y0z.

The LibreEcho Echo Gen 2 / MT8163 work also includes an independent
`amonet-k32` development repository. Any source, payload, binary, or tool
distributed from that repository must retain its own component-level copyright
and license notices, including the notices supplied with Amonet, mtkclient,
and incorporated support code.

## Linux and embedded support code

The LibreEcho kernel work is based on Linux and remains subject to the Linux
kernel's GPL-2.0-or-later licensing and the individual copyright, author, and
license notices present in the kernel source tree. See
[LibreEcho-Platform](https://github.com/aslater3/LibreEcho-Platform).

Some low-level support components retain separate notices, including code
copyrighted by Jörg Mische and components distributed under GPL and BSD-style
licenses. Those notices must remain with the applicable source or binary
distribution.

## Shairport Sync

LibreEcho currently uses [Shairport Sync](https://github.com/mikebrady/shairport-sync)
for AirPlay audio support.

- Project: [mikebrady/shairport-sync](https://github.com/mikebrady/shairport-sync)
- Primary project author/maintainer: Mike Brady
- Upstream documentation and source: see the linked repository
- License and copyright notices: retain the upstream [`COPYING`](https://github.com/mikebrady/shairport-sync/blob/master/COPYING) file and the complete [`LICENSES/`](https://github.com/mikebrady/shairport-sync/tree/master/LICENSES) directory when distributing Shairport Sync
- The exact source revision used by LibreEcho must be recorded with any binary distribution

Shairport Sync's upstream documentation acknowledges the heritage of Shairport,
including James Wah (`abrasive`), James Laird, and other contributors. Its
AirPlay 2 documentation also acknowledges contributors including JD Smith,
`ejurgensen`, `ckdo`, `invano`, and Charles Omer, and notes that much of its
AirPlay 2 functionality is based on ideas developed in the
[openairplay/airplay2-receiver](https://github.com/openairplay/airplay2-receiver)
project. Those acknowledgements belong to the upstream project; LibreEcho does
not claim their work as its own.

If Shairport Sync or another third-party component is redistributed with a
LibreEcho image or release, its complete upstream license and notice files must
be included with that distribution.

## Amazon disclaimer

LibreEcho is an independent community project. It is **not affiliated with,
associated with, authorised by, sponsored by, or endorsed by Amazon.com, Inc.,
Amazon Technologies, Inc., or any of their affiliates**. “Amazon”, “Echo”, and
related names and marks are used only to identify the hardware that this project
supports and remain the property of their respective owners.

## Experimental-use and limitation disclaimer

LibreEcho is early-stage experimental software and documentation for research,
educational, interoperability, and hardware-reuse purposes. It may be
incomplete, unstable, inaccurate, or unsuitable for any particular purpose. Use
it entirely at your own risk and only on hardware and systems that you own or
are authorised to modify.

Installing or using LibreEcho may erase data, change device software, disable
features, cause loss of functionality, or permanently damage hardware. You are
responsible for backups, device identity, recovery media, lawful use, network
security, and compliance with all applicable laws and third-party terms. Do not
use development builds on safety-critical, production, or otherwise important
systems without independent testing.

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LIBREECHO CONTRIBUTORS
PROVIDE THIS PROJECT “AS IS” AND DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED,
INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
TITLE, NON-INFRINGEMENT, SECURITY, ACCURACY, AND AVAILABILITY. TO THE MAXIMUM
EXTENT PERMITTED BY LAW, LIBREECHO CONTRIBUTORS WILL NOT BE LIABLE FOR ANY
INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR DIRECT LOSS OR
DAMAGE ARISING FROM OR RELATED TO USE OF THE PROJECT, INCLUDING LOSS OF DATA,
HARDWARE DAMAGE, LOSS OF FUNCTIONALITY, OR LOSS OF PROFITS.

This notice is intended as project documentation, not as legal advice. The
applicable law in your jurisdiction may limit some exclusions or limitations.
