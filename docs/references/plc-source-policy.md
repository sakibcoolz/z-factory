# PLC & Industrial Device Source/Data Policy

## Authoritative sources
Prefer manufacturer product pages, equipment/system/hardware manuals, electrical/wiring manuals, module catalogs, official register/protocol manuals and official CAD metadata.

## Initial PLC manufacturers
- Siemens: S7-1200 and S7-1500
- Rockwell Automation: CompactLogix 5380
- Schneider Electric: Modicon M241

## Peripheral manufacturers/models
Device categories may be seeded generically without claiming model-specific vendor specifications. A named vendor/model record is verified only when authoritative documentation supports its electrical, I/O, protocol/register and compatibility facts.

## Capture
Store normalized factual attributes plus:
- source URL
- document/product title
- document revision/version/date when available
- page/section reference where useful
- retrieval/verification date
- verification status

## Do not store by default
Full vendor manuals, proprietary firmware, engineering software, copyrighted imagery/CAD or protected application assets unless licensing explicitly permits it.

## Verification
A catalog profile is not marked verified until important electrical/I/O/communications/module compatibility facts are checked against authoritative documentation.

Never invent:
- pin/terminal mappings
- I/O counts
- electrical limits
- module compatibility
- Modbus/register maps
- fault codes
- protocol capabilities

When a generic simulator behavior is used because an exact vendor register/physics model is unavailable, label it as generic simulation rather than vendor behavior.
