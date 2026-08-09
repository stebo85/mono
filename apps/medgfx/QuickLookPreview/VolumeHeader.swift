//
//  VolumeHeader.swift
//  What a NIfTI header says will actually be materialised.
//
//  The point is not to identify the format — `PreviewFileKind` does that by
//  name. The point is that a NIfTI header states the decoded size exactly, in
//  the first 348 bytes (NIfTI-1) or 540 (NIfTI-2), and those bytes sit at the
//  very start of the stream. Gzip is forward-only, but byte 0 needs no random
//  access, so a ~1 ms bounded inflate answers a question the streaming bound
//  otherwise spends hundreds of milliseconds on.
//
//  It also answers a BETTER question. `GzipPeek.inflatedSize` measures what the
//  file CONTAINS. For a 4D series the preview never materialises that — it asks
//  NiiVue for one frame, and NiiVue's partial loader streams `vox_offset + one
//  frame` and cancels. Measured: a 594 MB 4D volume renders in 10 MB of JS heap.
//  Budgeting the whole payload refused files the page handles trivially.
//
//  Anything this cannot describe — NIfTI-2, byte-swapped, `.mgz`, `.nrrd.gz`,
//  `.gii.gz`, meshes — falls back to the streaming bound, which is unchanged.
//

import Foundation

struct VolumeHeader {
    /// Where image data starts: the header plus any extensions.
    let voxOffset: Int
    /// Bytes in ONE 3D frame.
    let frameBytes: Int
    /// Frames across dim[4..6]. 1 for a plain 3D volume.
    let totalFrames: Int
    /// True when NiiVue's partial 4D loader will engage for this file, so only
    /// the first frame is ever inflated. See `partialLoadEligible` below.
    let partialLoadEligible: Bool

    /// What the content process allocates when only frame zero is wanted.
    var firstFrameBytes: Int { voxOffset + frameBytes }
    /// What it allocates when the whole file must be inflated.
    var allFramesBytes: Int { voxOffset + frameBytes * totalFrames }

    /// Bytes to inflate before parsing. Covers a NIfTI-2 header (540) with room
    /// for a NIfTI-1 header plus a small extension.
    static let prefixBytes = 1024

    /// Parse a NIfTI-1 header from `data`, or nil if it is not one.
    ///
    /// **Little-endian NIfTI-1 only, deliberately.** This is not laziness about
    /// byte order — it is the precondition for the fast path being *correct*.
    /// `loadPartialNifti1` in NiiVue rejects a byte-swapped or NIfTI-2 header
    /// and falls back to a full load, so for those the whole payload really is
    /// inflated and the streaming bound is the honest measure. Widening this
    /// parser without widening NiiVue's would under-count.
    static func parse(_ data: Data) -> VolumeHeader? {
        let bytes = [UInt8](data)
        guard bytes.count >= 348 else { return nil }

        func i32(_ o: Int) -> Int32 {
            Int32(bytes[o]) | Int32(bytes[o + 1]) << 8 | Int32(bytes[o + 2]) << 16 | Int32(bytes[o + 3]) << 24
        }
        func i16(_ o: Int) -> Int16 { Int16(bytes[o]) | Int16(bytes[o + 1]) << 8 }
        func f32(_ o: Int) -> Float { Float(bitPattern: UInt32(bitPattern: i32(o))) }

        // 348 little-endian is the whole gate. A byte-swapped file reads as
        // 0x5C010000 here and is declined, which is what we want.
        guard i32(0) == 348 else { return nil }
        // `n+1\0` — a single-file NIfTI. A detached `ni1\0` pair has its image
        // in a sibling we neither claim nor can read.
        guard bytes[344] == 0x6E, bytes[345] == 0x2B, bytes[346] == 0x31 else { return nil }

        let dim = (0...7).map { Int(i16(40 + $0 * 2)) }
        let bitpix = Int(i16(72))
        // dim[0] is the rank; a value outside 1...7 means a header we should not
        // be doing arithmetic on.
        guard dim[0] >= 1, dim[0] <= 7, bitpix > 0, bitpix % 8 == 0 else { return nil }

        // A dimension of 0 is written by some tools where 1 is meant; clamping
        // matches how NiiVue computes `nVox3D`/`nTotal`.
        func extent(_ i: Int) -> Int { dim[i] > 1 ? dim[i] : 1 }
        let nVox3D = extent(1) * extent(2) * extent(3)
        let frames = extent(4) * extent(5) * extent(6)
        guard nVox3D > 0, frames > 0 else { return nil }

        // Overflow is the reason these are checked rather than multiplied
        // blindly: dims are attacker-controlled and 16-bit each, so a crafted
        // header can otherwise wrap Int on the multiply.
        let (frameBytes, frameOverflow) = nVox3D.multipliedReportingOverflow(by: bitpix / 8)
        guard !frameOverflow else { return nil }

        let voxOffset = Int(f32(108))
        // vox_offset is an integer byte count stored as a float. Reject NaN,
        // negatives, sub-header values and anything past the prefix we read.
        guard f32(108).isFinite, voxOffset >= 348, voxOffset <= prefixBytes else { return nil }

        let intentCode = Int(i16(68))
        // Intent 1007 is NIFTI_INTENT_VECTOR (RGB vector); NiiVue declines the
        // partial path for it because dim4 is components, not time.
        let eligible = frames > 1 && intentCode != 1007

        return VolumeHeader(
            voxOffset: voxOffset,
            frameBytes: frameBytes,
            totalFrames: frames,
            partialLoadEligible: eligible
        )
    }

    /// Read and parse the header of the file at `url`, inflating if needed.
    static func read(atFileURL url: URL) -> VolumeHeader? {
        guard let data = GzipPeek.prefix(ofFileAt: url, bytes: prefixBytes) else { return nil }
        return parse(data)
    }
}
