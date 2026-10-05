# Catalog Sources

Manufacturer documents the vendor catalog records were read from (`lib/catalog/vendor/`). Per `plc-source-policy.md` the documents themselves are not stored in the repository; only normalized facts and these references are.

All retrieved and checked on 2026-10-05.

| Record | Document | Revision | URL |
|---|---|---|---|
| Siemens CPU 1214C DC/DC/DC (6ES7214-1AG40-0XB0) | SIMATIC S7-1200 Easy Book | A5E02486774-AG, 01/2015 | https://cache.industry.siemens.com/dl/files/145/39710145/att_5787/v1/s71200_easy_book_en-US_en-US.pdf |
| Siemens CPU 1511-1 PN (6ES7511-1AK02-0AB0) | SIMATIC S7-1500 CPU 1511-1 PN Equipment Manual | A5E40869673-AB, 05/2021 | https://cache.industry.siemens.com/dl/files/841/109752841/att_936124/v4/s71500_cpu1511_1_pn_dtc_manual_en-US_en-US.pdf |
| Siemens DI 16x24VDC BA (6ES7521-1BH10-0AA0) | Digital input module manual | A5E32363114-AD, 12/2016 | https://cache.industry.siemens.com/dl/files/190/83501190/att_905051/v1/s71500_di_16x24vdc_ba_manual_en-US_en-US.pdf |
| Siemens DQ 16x24VDC/0.5A BA (6ES7522-1BH10-0AA0) | Digital output module manual | A5E32364017-AC, 09/2016 | https://cache.industry.siemens.com/dl/files/415/83500415/att_902638/v1/s71500_dq_16x24vdc_0_5a_ba_manual_en-US_en-US.pdf |
| Siemens AI 8xU/I/RTD/TC ST (6ES7531-7KF00-0AB0) | Analog input module manual | A5E03484864-AE, 08/2018 | https://cache.industry.siemens.com/dl/files/205/59193205/att_902256/v1/s71500_ai_8xu_i_rtd_tc_st_manual_en-US_en-US.pdf |
| Siemens AQ 4xU/I ST (6ES7532-5HD00-0AB0) | Analog output module manual | A5E03484696-AE, 08/2018 | https://cache.industry.siemens.com/dl/files/850/59191850/att_903132/v1/s71500_aq_4xu_i_st_manual_en-US_en-US.pdf |
| Rockwell 5069-L306ER | CompactLogix 5380, Compact GuardLogix 5380, and CompactLogix 5480 Controllers Specifications | 5069-TD002O-EN-P, November 2023 | https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td002_-en-p.pdf |
| Rockwell 5069-IB16, 5069-OB16, 5069-IF8, 5069-OF4 | Compact 5000 I/O and Specialty Modules Specifications | 5069-TD001P-EN-P, March 2026 | https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td001_-en-p.pdf |
| Schneider TM241CE24T | Modicon M241 Logic Controller Hardware Guide | EIO0000003083.08, 04/2026 | https://download.schneider-electric.com/files?p_Doc_Ref=EIO0000003083 |

## Notes
- Siemens product data sheets (SiePortal) and Schneider product pages refused automated retrieval; the manuals above were used instead.
- The S7-1200 source is the 01/2015 edition of the Easy Book, which lists the 6ES7214-1AG40-0XB0. A newer system manual was not reachable.
- The Rockwell controller publication lists EtherNet/IP and socket interfaces but does not state Modbus TCP, so the record claims no Modbus TCP port.
