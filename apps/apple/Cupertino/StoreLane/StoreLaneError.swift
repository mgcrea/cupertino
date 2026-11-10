import Foundation

/// Why a store-lane call did not write, with a reason a caller can branch on and a message a
/// person can read.
///
/// `reason` is the case name spelled as a string, so it crosses the socket unchanged.
nonisolated enum StoreLaneError: Error, Equatable {
  /// The request itself is malformed: a missing or wrong-typed argument.
  case invalid(String)
  /// The thing the call names is not there, or is not exactly one thing.
  case notFound(String)
  /// The store and the model disagree, so the lane refuses rather than migrate Apple's store.
  case incompatible(String)
  /// The surface's writes are switched off.
  case writesOff(String)
  /// Anything else: the model did not load, the store did not open, the save failed.
  case failed(String)

  var reason: String {
    switch self {
    case .invalid: "invalid"
    case .notFound: "notFound"
    case .incompatible: "incompatible"
    case .writesOff: "writesOff"
    case .failed: "failed"
    }
  }

  var message: String {
    switch self {
    case .invalid(let message), .notFound(let message), .incompatible(let message),
      .writesOff(let message), .failed(let message):
      message
    }
  }
}
