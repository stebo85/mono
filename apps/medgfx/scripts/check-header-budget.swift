//
//  check-header-budget.swift
//  The header-first budget: what gets accepted, what still gets refused.
//
//  Run it: bash scripts/check-header-budget.sh
//
//  The pairs below are the whole point. A 4D series over the cap must be
//  ACCEPTED (only one frame is ever inflated), while a 3D volume over the same
//  cap must still be REFUSED (the whole thing is). If someone widens
//  `VolumeHeader.parse` past what NiiVue's partial loader accepts, the 3D cases
//  are what fail.
//

import Foundation

@main
enum HeaderBudgetCheck {
    static let cap = 256 * 1024 * 1024
    static var failures = 0

    /// Minimal single-file NIfTI-1, little-endian.
    static func nifti1(dims: [Int16], bitpix: Int16 = 16, intent: Int16 = 0,
                       magic: String = "n+1", sizeofHdr: Int32 = 348) -> Data {
        var h = [UInt8](repeating: 0, count: 352)
        func put32(_ v: Int32, _ o: Int) {
            let u = UInt32(bitPattern: v)
            for i in 0..<4 { h[o + i] = UInt8((u >> (8 * UInt32(i))) & 0xFF) }
        }
        func put16(_ v: Int16, _ o: Int) {
            let u = UInt16(bitPattern: v)
            h[o] = UInt8(u & 0xFF); h[o + 1] = UInt8((u >> 8) & 0xFF)
        }
        put32(sizeofHdr, 0)
        for (i, d) in dims.enumerated() where i < 8 { put16(d, 40 + i * 2) }
        put16(intent, 68)
        put16(512, 70)          // DT_UINT16
        put16(bitpix, 72)
        put32(Int32(bitPattern: Float(352).bitPattern), 108)  // vox_offset
        for (i, c) in magic.utf8.enumerated() { h[344 + i] = c }
        return Data(h)
    }

    static func expect(_ name: String, _ data: Data,
                       eligible: Bool?, firstFrameMB: Int?, allMB: Int?) {
        guard let h = VolumeHeader.parse(data) else {
            let ok = eligible == nil
            if !ok { failures += 1 }
            print("\(ok ? "PASS" : "FAIL")  \(name) -> not a parseable NIfTI-1")
            return
        }
        guard let wantEligible = eligible else {
            failures += 1
            print("FAIL  \(name) -> parsed, but should not have")
            return
        }
        var ok = h.partialLoadEligible == wantEligible
        if let f = firstFrameMB { ok = ok && h.firstFrameBytes / 1048576 == f }
        if let a = allMB { ok = ok && h.allFramesBytes / 1048576 == a }
        if !ok { failures += 1 }
        print("\(ok ? "PASS" : "FAIL")  \(name) -> eligible=\(h.partialLoadEligible)"
              + " frame=\(h.firstFrameBytes / 1048576)MB all=\(h.allFramesBytes / 1048576)MB")
    }

    /// What `budgetFailure` would decide, given only the header.
    static func verdict(_ h: VolumeHeader) -> String {
        if h.partialLoadEligible { return h.firstFrameBytes > cap ? "refuse" : "accept" }
        return h.allFramesBytes > cap ? "refuse" : "defer-to-payload-bound"
    }

    static func expectVerdict(_ name: String, _ data: Data, _ want: String) {
        guard let h = VolumeHeader.parse(data) else {
            failures += 1; print("FAIL  \(name) -> unparseable"); return
        }
        let got = verdict(h)
        if got != want { failures += 1 }
        print("\(got == want ? "PASS" : "FAIL")  \(name) -> \(got)")
    }

    static func main() {
        // 104x104x72 uint16 = 1.49 MB per frame.
        let shape: [Int16] = [4, 104, 104, 72]

        // THE CASE THIS CHANGE EXISTS FOR: 400 frames = 594 MB total, over the
        // cap, but one frame is 1.49 MB. Must be accepted.
        expect("4D 400 frames", nifti1(dims: shape + [400]),
               eligible: true, firstFrameMB: 1, allMB: 594)
        expectVerdict("4D 400 frames verdict", nifti1(dims: shape + [400]), "accept")

        // The real dataset that prompted this: 105 frames, 156 MB.
        expectVerdict("4D 105 frames verdict", nifti1(dims: shape + [105]), "accept")

        // THE GUARD: a 3D volume over the cap is fully inflated, so it must NOT
        // take the fast path. 700x700x700 uint16 = 654 MB.
        expect("3D oversize", nifti1(dims: [3, 700, 700, 700]),
               eligible: false, firstFrameMB: nil, allMB: 654)
        expectVerdict("3D oversize verdict", nifti1(dims: [3, 700, 700, 700]), "refuse")

        // An ordinary 3D volume defers to the payload bound, which is what
        // catches a lying header.
        expectVerdict("3D ordinary verdict", nifti1(dims: [3, 104, 104, 72]),
                      "defer-to-payload-bound")

        // Headers NiiVue's partial loader declines must not take the fast path.
        expect("RGB vector 4D", nifti1(dims: shape + [3], intent: 1007),
               eligible: false, firstFrameMB: nil, allMB: nil)
        expect("detached ni1", nifti1(dims: shape + [400], magic: "ni1"),
               eligible: nil, firstFrameMB: nil, allMB: nil)
        expect("NIfTI-2 sizeof_hdr", nifti1(dims: shape + [400], sizeofHdr: 540),
               eligible: nil, firstFrameMB: nil, allMB: nil)
        expect("byte-swapped", nifti1(dims: shape + [400], sizeofHdr: 0x5C01_0000),
               eligible: nil, firstFrameMB: nil, allMB: nil)

        // Malformed headers must be declined, not arithmetic'd on.
        expect("bitpix 0", nifti1(dims: shape + [400], bitpix: 0),
               eligible: nil, firstFrameMB: nil, allMB: nil)
        expect("rank 0", nifti1(dims: [0, 104, 104, 72, 400]),
               eligible: nil, firstFrameMB: nil, allMB: nil)
        expect("truncated", Data([UInt8](repeating: 0, count: 100)),
               eligible: nil, firstFrameMB: nil, allMB: nil)

        print(failures == 0 ? "\nall checks passed" : "\n\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}
