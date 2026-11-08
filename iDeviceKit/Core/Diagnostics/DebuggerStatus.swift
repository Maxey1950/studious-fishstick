import Foundation
import Darwin

enum DebuggerStatus {
    /// True if a debugger is currently attached to THIS process (P_TRACED via sysctl).
    /// This reports attachment only. It does not grant, and cannot test for, JIT permission.
    static func isBeingTraced() -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let rc = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard rc == 0 else { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }
}
