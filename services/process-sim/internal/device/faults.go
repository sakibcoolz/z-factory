package device

// The fault standard of the catalog simulator (TASK-1014). Every fault of every profile
// is one of these shapes, and injecting, clearing and resetting mean the same for all:
//
//   - Injecting a fault makes its condition present from the next step; clearing ends the
//     condition. A behaviour may raise and release a fault from its own physics the same
//     way (Context.Raise / Release), and the events say which happened.
//   - A latching fault trips the device: the trip outlives the cause and ends only on a
//     rising edge of the PLC's faultReset signal or the operator's reset, never by itself.
//     Whether a fault latches is the profile's statement, which the catalog may override.
//   - A silent fault is one the device cannot report on its own fault output (a stuck
//     valve, a welded contact, a lost supply); the PLC sees its effect, not a flag.
//   - Quality is the trust in a device's feedback: BAD while a fault the profile names as
//     bad-quality is present, while the device is unavailable, while the runtime has set
//     it aside, and while the device it measures is BAD. Quality travels along `measures`
//     links and changes are events.
//   - Faults act on feedback only. Nothing here writes a PLC output; the PLC decides what
//     to do with what it reads.
//
// Two faults are generic and belong to every device: OFFLINE on every profile, and
// COMM_LOSS on every device served over a protocol.

// OfflineFault is the device unavailable: lost supply, disconnected, powered down. The
// behaviour is not stepped, its outputs read de-energized, its quality is BAD, and when
// the fault ends the behaviour restarts from its initial state, as equipment does after
// a power cycle. Silent: an unpowered device reports nothing.
var OfflineFault = Fault{Code: "OFFLINE", Name: "Device unavailable", Severity: Critical, Latching: false, Silent: true}

// CommLossFault is the loss of communication with a device served over a protocol: the
// runtime stops answering for its unit id (exception 0B), its behaviour goes on, and its
// quality is BAD because nothing of it can be read. Silent for the same reason.
var CommLossFault = Fault{Code: "COMM_LOSS", Name: "Communication lost", Severity: Critical, Latching: false, Silent: true}

// withGenericFaults appends the faults every profile has to a description.
func withGenericFaults(description Description) Description {
	for _, fault := range description.Faults {
		if fault.Code == OfflineFault.Code {
			return description
		}
	}
	faults := make([]Fault, 0, len(description.Faults)+1)
	faults = append(faults, description.Faults...)
	faults = append(faults, OfflineFault)
	description.Faults = faults
	return description
}

// deEnergized is what a device's feedback reads while it is unavailable: every output
// at zero, as the wiring of powered-down equipment reads.
func deEnergized(description Description) Values {
	outputs := Values{}
	for _, signal := range description.Signals {
		if signal.Direction == Out {
			outputs[signal.Key] = 0
		}
	}
	return outputs
}
