package device

// The generic register map of a drive commanded over Modbus TCP (TASK-1013): Z-Factory's
// own declaration for the generic Modbus drive of the catalog, not any vendor's map. The
// commands are coils, the setpoint a holding register in tenths of a hertz, the boolean
// feedback discrete inputs and the numeric feedback input registers in tenths. The
// behaviour behind it is the VFD profile unchanged: a write sets the same inputs a
// hardwired terminal would, and the PLC reads the same feedback.
func init() {
	RegisterMapOf(RegisterMap{
		Key:            "VFD_MODBUS_TCP",
		Version:        1,
		Protocol:       ProtocolModbusTCP,
		Profile:        "VFD",
		ProfileVersion: 1,
		Summary:        "The generic drive over Modbus TCP: run, reverse and fault reset as coils, the frequency setpoint as a holding register in 0.1 Hz, running, at-setpoint and fault as discrete inputs, actual frequency and output current as input registers in 0.1 Hz and 0.1 A.",
		Registers: []RegisterSpec{
			{Signal: "run", Area: Coil, Address: 0, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"},
			{Signal: "reverse", Area: Coil, Address: 1, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"},
			{Signal: "faultReset", Area: Coil, Address: 2, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"},
			{Signal: "frequencySetpoint", Area: HoldingRegister, Address: 0, DataType: "UINT16", WordCount: 1, Scale: 0.1, Unit: "Hz", Access: "READ_WRITE", Role: "SETPOINT", Range: &RegisterRange{Min: f64(0), MaxParameter: "maxFrequencyHz"}},
			{Signal: "running", Area: DiscreteInput, Address: 0, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "STATUS"},
			{Signal: "atSetpoint", Area: DiscreteInput, Address: 1, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "STATUS"},
			{Signal: "faulted", Area: DiscreteInput, Address: 2, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "ALARM"},
			{Signal: "actualFrequency", Area: InputRegister, Address: 0, DataType: "UINT16", WordCount: 1, Scale: 0.1, Unit: "Hz", Access: "READ_ONLY", Role: "FEEDBACK"},
			{Signal: "outputCurrent", Area: InputRegister, Address: 1, DataType: "UINT16", WordCount: 1, Scale: 0.1, Unit: "A", Access: "READ_ONLY", Role: "FEEDBACK"},
		},
	})
}
