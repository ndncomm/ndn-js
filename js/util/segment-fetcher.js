/**
 * Copyright (C) 2015 Regents of the University of California.
 * @author: Jeff Thompson <jefft0@remap.ucla.edu>
 * @author: From ndn-cxx util/segment-fetcher https://github.com/named-data/ndn-cxx
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * A copy of the GNU Lesser General Public License is in the file COPYING.
 */

var Interest = require('../interest.js').Interest;
var Blob = require('./blob.js').Blob;

/**
 * SegmentFetcher is a utility class to fetch the latest version of segmented data.
 *
 * SegmentFetcher assumes that the data is named /<prefix>/<version>/<segment>,
 * where:
 * - <prefix> is the specified name prefix,
 * - <version> is an unknown version that needs to be discovered, and
 * - <segment> is a segment number. (The number of segments is unknown and is
 *   controlled by the `FinalBlockId` field in at least the last Data packet.
 *
 * The following logic is implemented in SegmentFetcher:
 *
 * 1. Express the first Interest to discover the version:
 *
 *    >> Interest: /<prefix>?ChildSelector=1&MustBeFresh=true
 *
 * 2. Infer the latest version of the Data: <version> = Data.getName().get(-2)
 *
 * 3. If the segment number in the retrieved packet == 0, go to step 5.
 *
 * 4. Send an Interest for segment 0:
 *
 *    >> Interest: /<prefix>/<version>/<segment=0>
 *
 * 5. Keep sending Interests for the next segment while the retrieved Data does
 *    not have a FinalBlockId or the FinalBlockId != Data.getName().get(-1).
 *
 *    >> Interest: /<prefix>/<version>/<segment=(N+1))>
 *
 * 6. Call the onComplete callback with a Blob that concatenates the content
 *    from all the segmented objects.
 *
 * If an error occurs during the fetching process, the onError callback is called
 * with a proper error code.  The following errors are possible:
 *
 * - `INTEREST_TIMEOUT`: if any of the Interests times out
 * - `DATA_HAS_NO_SEGMENT`: if any of the retrieved Data packets don't have a segment
 *   as the last component of the name (not counting the implicit digest)
 * - `SEGMENT_VERIFICATION_FAILED`: if any retrieved segment fails
 *   the user-provided VerifySegment callback
 * - `IO_ERROR`: for I/O errors when sending an Interest.
 *
 * In order to validate individual segments, a verifySegment callback needs to
 * be specified. If the callback returns false, the fetching process is aborted
 * with SEGMENT_VERIFICATION_FAILED. If data validation is not required, the
 * provided DontVerifySegment object can be used.
 *
 * Example:
 *     var onComplete = function(content) { ... }
 *
 *     var onError = function(errorCode, message) { ... }
 *
 *     var interest = new Interest(new Name("/data/prefix"));
 *     interest.setInterestLifetimeMilliseconds(1000);
 *
 *     SegmentFetcher.fetch
 *       (face, interest, SegmentFetcher.DontVerifySegment, onComplete, onError);
 *
 * This is a private constructor to create a new SegmentFetcher to use the Face.
 * An application should use SegmentFetcher.fetch.
 * @param {Face} face This calls face.expressInterest to fetch more segments.
 * @param {function} verifySegment When a Data packet is received this calls
 * verifySegment(data) where data is a Data object. If it returns False then
 * abort fetching and call onError with
 * SegmentFetcher.ErrorCode.SEGMENT_VERIFICATION_FAILED.
 * @param {function} onComplete When all segments are received, call
 * onComplete(content) where content is a Blob which has the concatenation of
 * the content of all the segments.
 * @param {function} onError Call onError.onError(errorCode, message) for
 * timeout or an error processing segments. errorCode is a value from
 * SegmentFetcher.ErrorCode and message is a related string.
 * @constructor
 */
var SegmentFetcher = function SegmentFetcher
  (face, verifySegment, onComplete, onError)
{
  this.face = face;
  this.verifySegment = verifySegment;
  this.onComplete = onComplete;
  this.onError = onError;

  this.contentParts = []; // of Buffer
};

exports.SegmentFetcher = SegmentFetcher;

/**
 * An ErrorCode value is passed in the onError callback.
 */
SegmentFetcher.ErrorCode = {
  INTEREST_TIMEOUT: 1,
  DATA_HAS_NO_SEGMENT: 2,
  SEGMENT_VERIFICATION_FAILED: 3
};

/**
 * DontVerifySegment may be used in fetch to skip validation of Data packets.
 */
SegmentFetcher.DontVerifySegment = function(data)
{
  return true;
};

/**
 * Initiate segment fetching. For more details, see the documentation for the
 * class.
 * @param {Face} face This calls face.expressInterest to fetch more segments.
 * @param {Interest} baseInterest An Interest for the initial segment of the
 * requested data, where baseInterest.getName() has the name prefix. This
 * interest may include a custom InterestLifetime and selectors that will
 * propagate to all subsequent Interests. The only exception is that the initial
 * Interest will be forced to include selectors "ChildSelector=1" and
 * "MustBeFresh=true" which will be turned off in subsequent Interests.
 * @param {function} verifySegment When a Data packet is received this calls
 * verifySegment(data) where data is a Data object. If it returns False then
 * abort fetching and call onError with
 * SegmentFetcher.ErrorCode.SEGMENT_VERIFICATION_FAILED. If data validation is
 * not required, use SegmentFetcher.DontVerifySegment.
 * @param {function} onComplete When all segments are received, call
 * onComplete(content) where content is a Blob which has the concatenation of
 * the content of all the segments.
 * @param {function} onError Call onError.onError(errorCode, message) for
 * timeout or an error processing segments. errorCode is a value from
 * SegmentFetcher.ErrorCode and message is a related string.
 */
SegmentFetcher.fetch = function
  (face, baseInterest, verifySegment, onComplete, onError)
{
  new SegmentFetcher(face, verifySegment, onComplete, onError).fetchFirstSegment
    (baseInterest);
};

SegmentFetcher.prototype.fetchFirstSegment = function(baseInterest)
{
  var interest = new Interest(baseInterest);
  interest.setChildSelector(1);
  interest.setMustBeFresh(true);
  var thisSegmentFetcher = this;
  this.face.expressInterest
    (interest,
     function(originalInterest, data)
       { thisSegmentFetcher.onData(originalInterest, data); },
     function(interest) { thisSegmentFetcher.onTimeout(interest); });
};

SegmentFetcher.prototype.fetchNextSegment = function
  (originalInterest, dataName, segment)
{
  // Start with the original Interest to preserve any special selectors.
  var interest = new Interest(originalInterest);
  // Changing a field clears the nonce so that the library will generate a new
  // one.
  interest.setMustBeFresh(false);
  interest.setName(dataName.getPrefix(-1).appendSegment(segment));
  var thisSegmentFetcher = this;
  this.face.expressInterest
    (interest, function(originalInterest, data)
       { thisSegmentFetcher.onData(originalInterest, data); },
     function(interest) { thisSegmentFetcher.onTimeout(interest); });
};

SegmentFetcher.prototype.onData = function(originalInterest, data)
{
  if (!this.verifySegment(data)) {
    this.onError
      (SegmentFetcher.ErrorCode.SEGMENT_VERIFICATION_FAILED,
       "Segment verification failed");
    return;
  }

  if (!SegmentFetcher.endsWithSegmentNumber(data.getName()))
    // We don't expect a name without a segment number.  Treat it as a bad packet.
    this.onError
      (SegmentFetcher.ErrorCode.DATA_HAS_NO_SEGMENT,
       "Got an unexpected packet without a segment number: " +
        data.getName().toUri());
  else {
    var currentSegment = 0;
    try {
      currentSegment = data.getName().get(-1).toSegment();
    }
    catch (ex) {
      this.onError(
        SegmentFetcher.ErrorCode.DATA_HAS_NO_SEGMENT,
         "Error decoding the name segment number " +
         data.getName().get(-1).toEscapedString() + ": " + ex);
      return;
    }

    var expectedSegmentNumber = this.contentParts.length;
    if (currentSegment != expectedSegmentNumber)
      // Try again to get the expected segment.  This also includes the case
      // where the first segment is not segment 0.
      this.fetchNextSegment
        (originalInterest, data.getName(), expectedSegmentNumber);
    else {
      // Save the content and check if we are finished.
      this.contentParts.push(data.getContent().buf());

      if (data.getMetaInfo().getFinalBlockId().getValue().size() > 0) {
        var finalSegmentNumber = 0;
        try {
          finalSegmentNumber = (data.getMetaInfo().getFinalBlockId().toSegment());
        }
        catch (ex) {
          this.onError
            (SegmentFetcher.ErrorCode.DATA_HAS_NO_SEGMENT,
             "Error decoding the FinalBlockId segment number " +
             data.getMetaInfo().getFinalBlockId().toEscapedString() +
             ": " + ex);
          return;
        }

        if (currentSegment == finalSegmentNumber) {
          // We are finished.

          // Concatenate to get content.
          var content = Buffer.concat(this.contentParts);
          this.onComplete(new Blob(content, false));
          return;
        }
      }

      // Fetch the next segment.
      this.fetchNextSegment
        (originalInterest, data.getName(), expectedSegmentNumber + 1);
    }
  }
};

SegmentFetcher.prototype.onTimeout = function(interest)
{
  this.onError
    (SegmentFetcher.ErrorCode.INTEREST_TIMEOUT,
     "Time out for interest " + interest.getName().toUri());
};

/**
 * Check if the last component in the name is a segment number.
 * @param {Name} name The name to check.
 * @returns {boolean} True if the name ends with a segment number, otherwise false.
 */
SegmentFetcher.endsWithSegmentNumber = function(name)
{
  return name.size() >= 1 &&
         name.get(-1).getValue().size() >= 1 &&
         name.get(-1).getValue().buf()[0] == 0;
};
