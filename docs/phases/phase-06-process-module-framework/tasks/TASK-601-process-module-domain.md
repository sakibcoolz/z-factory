# TASK-601 — Process Module Domain & Persistence

Status: **DONE**
Linear: [ZFA-24](https://linear.app/recruit-verse/issue/ZFA-24)

## Goal
Add the reusable process-module domain without mixing process-specific concepts into the generic device catalog.

## Scope
- ProcessModuleType and ProcessModuleInstance
- ModuleDevice role assignment
- ModuleSignalDefinition logical I/O contract
- ModuleInterlock metadata
- ownership, naming and factory-scoping rules
- schema migration, repositories, validation and tests
- update database/API documentation

PLC endpoint allocation and the module-level consumed-I/O registry are implemented separately in TASK-605.

## Invariants
- Process modules reference existing factory DeviceInstances; they do not duplicate device models.
- Process role is separate from manufacturer/model identity.
- No boiler-specific fields belong in the generic schema beyond extensible module configuration.
- Module signal definitions describe logical process I/O; they do not reserve physical PLC endpoints by themselves.
- A module may have different optional I/O counts/configurations depending on its selected profile.

## Acceptance
- A factory can create multiple uniquely named process-module instances.
- Devices can be assigned to typed module roles.
- Module types can declare required and optional logical INPUT/OUTPUT/INTERNAL/ALARM signals.
- Invalid cross-factory device assignment is rejected.
- Tests cover persistence and validation invariants.

## Evidence (2026-10-05)
Implemented and verified on 2026-10-05; accepted by the owner on 2026-10-06.

- **A factory can create multiple uniquely named module instances.** `createModule` stores a `ProcessModuleInstance` of a type in a factory; `(factoryId, name)` is unique in the database. Tested against PostgreSQL: three modules in one factory, a second module with a taken name refused as a conflict, the same name accepted in another factory, a module of another owner's factory not found.
- **Devices can be assigned to typed module roles.** A type declares its roles (`ModuleRoleDefinition`: device categories, required or optional, number of devices, profiles); `assignModuleDevice` puts an existing `DeviceInstance` into one. Tested: a pump and a pressure transmitter complete a pump house; a valve as duty pump, a role outside the profile, an unknown role, a full role and the same device twice in one role are refused; a role's last place goes to one of four assignments made at the same time (the test fails without the row lock in two of three runs); the device row is identical before and after; a device can serve two modules.
- **Types declare required and optional INPUT/OUTPUT/INTERNAL/ALARM signals.** `ModuleSignalDefinition` with direction, data type, tag role, unit, range, required flag, owning role and profiles. The shipped `PUMP_HOUSE` has 7 inputs (3 required), 5 outputs (2 required), 1 internal value and 2 alarms in its largest profile and fewer in `SINGLE_PUMP`. Tested: definitions with an output that is not a command, an input that is a command, a backwards range, a signal on a missing role or in a profile its role is not in are refused; the database refuses the direction/role and range rules too.
- **Invalid cross-factory device assignment is rejected.** A device of another factory of the same owner is refused with `module-device-factory` ("P-901 belongs to another factory."); a device of another owner is not found; no `ModuleDevice` row is written in either case (tested).
- **Tests cover persistence and validation invariants.** 78 new tests: 46 for the pure rules, 12 for definitions and the shipped types, 20 against PostgreSQL (type versions, seeding twice, instances, profiles, configuration, roles, concurrency, interlocks, ownership, cascades), plus the enum parity entry. Full run with `TEST_DOCKER=1`: 819 tests in 66 files pass. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass.

Invariants:
- **Modules reference existing devices.** `ModuleDevice` holds a device id and a role id, nothing of the device's model. Deleting a module leaves its devices; deleting a device removes its assignments and the module reports the role empty (tested).
- **Process role is separate from identity.** A role names device categories only; a test checks that the shipped types name no manufacturer or model.
- **No process-specific fields.** Settings are declared by the type (`configSchemaJson`) and stored in `configJson`; a setting the type does not declare is refused (tested).
- **Signal definitions reserve no PLC endpoint.** No table of this task refers to a tag or I/O point; a test creates and fills a module and finds no tag and no I/O point.
- **I/O counts follow the profile.** Roles and signals name the profiles they apply to; signal counts are computed for the selected profile (tested with `PUMP_HOUSE`: `SINGLE_PUMP` has 5 inputs and 3 outputs, `DUTY_STANDBY` 7 and 5).

## Decisions made in this task
- **Roles are declared by the type.** New table `ModuleRoleDefinition`, in place of the free `roleKey` and `required` on `ModuleDevice` of the model planned before Phase 06: a role can only be "typed" if the type says which categories fit, whether it is required and how many devices it takes. `docs/database.md` is updated.
- **Profiles are columns.** `ProcessModuleType.profiles`, `ProcessModuleInstance.profile` and `profiles` on roles and signals, so the database and the registry of TASK-605 can read which signals a module has without interpreting JSON.
- **A type version is written once.** Seeding leaves stored versions alone and refuses a definition that differs from its stored version; a changed template is a new version. Module instances keep the version they were created from.
- **Types are reference data.** Like the catalog they are not owned by a factory; `defineModuleType` and the seed write them. Whether types are edited in the UI is left to TASK-604.
- **Two generic types are shipped:** `PUMP_HOUSE` and `TANK`, each with two profiles. Their `simulatorModelType` is null and their configuration fields have no reader until the process runtime exists (TASK-602).
- **Interlocks are a small structure, not free text:** `{ when: [{ signal, operator, value? }], blocks: [output] }`, checked against the signals of the module's profile. They are metadata and act on nothing.
- **`ModulePlcIoMapping` is not created here.** It belongs to TASK-605 with its allocation rules; `docs/database.md` marks it as planned.
- **Database rules:** six CHECK constraints (type code and version, role capacity, signal direction/role, signal range, module name), listed in `docs/database.md`.
- **No UI, route or server action** in this task (TASK-604), and no new dependency or environment variable.
- **Development database:** the forward migration `20261005170000_process_modules` is applied and the two shipped types are stored (no module instance; the `milk` factory is untouched).

