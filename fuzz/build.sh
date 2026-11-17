#!/bin/bash
#
# Builds the libFuzzer harnesses from the OpenCCU-Base sources with clang's fuzzer, address and undefined-behaviour
# sanitizers. The library sources are compiled straight into each harness.
#
# Usage: build.sh <openccu-base dir> <output dir>
#
set -euo pipefail

SRC=${1:?usage: $0 <openccu-base dir> <output dir>}
OUT=${2:?missing output dir}
HERE=$(cd "$(dirname "$0")" && pwd)
CXX=${CXX:-clang++}

FLAGS=(
  -std=c++11 -g -O1
  -fsanitize=fuzzer,address,undefined
  -fno-omit-frame-pointer
  -D_TIME_BITS=64 -D_FILE_OFFSET_BITS=64
  -Wno-deprecated-declarations
)

XMLRPC="$SRC/src/libXmlRpc/src"
XMLPARSER="$SRC/src/libxmlparser"
mkdir -p "$OUT"

# Since OpenCCU-Base #294 a component's version.cpp (libelvutils' among them) includes generated-<name>-version.h,
# which CMake writes into the build tree: `sh version.sh`, stripped, as `#define <MACRO> "<version>"`
# (openccu_version_header() in CMakeLists.txt with cmake/WriteVersionHeader.cmake; rfd, hs485d and multimacd spell
# the same two commands out in their own CMakeLists.txt). Do the same for every component that declares one, reading
# name and macro from its CMakeLists.txt, so the headers carry the real versions. A ref from before #294 declares
# none and gets none.
GEN=$(mktemp -d)
trap 'rm -rf "$GEN"' EXIT
for cml in "$SRC"/src/*/CMakeLists.txt; do
  dir=$(dirname "$cml")
  # openccu_version_header(<target> <name> <MACRO>), or the spelled-out form's output file and -DMACRO_NAME=
  decl=$(sed -n 's/^[[:space:]]*openccu_version_header([[:space:]]*[^[:space:]]*[[:space:]]\{1,\}\([^[:space:]]*\)[[:space:]]\{1,\}\([A-Za-z0-9_]*\)[[:space:]]*).*/\1 \2/p' "$cml")
  if [ -z "$decl" ] && grep -q 'WriteVersionHeader\.cmake' "$cml"; then
    name=$(sed -n 's/.*generated-\([^"/]*\)-version\.h.*/\1/p' "$cml" | sort -u)
    macro=$(sed -n 's/.*-DMACRO_NAME=\([A-Za-z0-9_]*\).*/\1/p' "$cml" | sort -u)
    decl="$name $macro"
  fi
  [ -n "$decl" ] || continue
  read -r name macro rest <<<"$decl"
  if [ -z "$name" ] || [ -z "$macro" ] || [ -n "$rest" ] || [ ! -f "$dir/version.sh" ]; then
    echo "cannot read the version header declaration of $cml: '$decl'" >&2
    exit 1
  fi
  version=$(sh "$dir/version.sh")
  # CMake's string(STRIP): leading and trailing whitespace
  version=$(printf '%s' "$version" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  printf '#define %s "%s"\n' "$macro" "$version" >"$GEN/generated-$name-version.h"
  echo "generated-$name-version.h: $macro \"$version\""
done
FLAGS+=(-I"$GEN")

echo "building fuzz_xmlrpc_value"
"$CXX" "${FLAGS[@]}" -I"$XMLRPC" "$HERE/fuzz_xmlrpc_value.cpp" "$XMLRPC"/*.cpp -o "$OUT/fuzz_xmlrpc_value"
echo "building fuzz_xmlrpc_request"
"$CXX" "${FLAGS[@]}" -I"$XMLRPC" "$HERE/fuzz_xmlrpc_request.cpp" "$XMLRPC"/*.cpp -o "$OUT/fuzz_xmlrpc_request"
echo "building fuzz_xmlparser"
"$CXX" "${FLAGS[@]}" -I"$XMLPARSER" "$HERE/fuzz_xmlparser.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/fuzz_xmlparser"
echo "building fuzz_xmlparser_edit"
"$CXX" "${FLAGS[@]}" -I"$XMLPARSER" "$HERE/fuzz_xmlparser_edit.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/fuzz_xmlparser_edit"
echo "building test_xmlparser_cleartags (not a fuzzer)"
"$CXX" -std=c++11 -g -O1 -fsanitize=address,undefined -Wno-deprecated-declarations -I"$XMLPARSER" \
  "$HERE/test_xmlparser_cleartags.cpp" "$XMLPARSER/xmlParser.cpp" -o "$OUT/test_xmlparser_cleartags"

# libelvutils (Logger, PropertyMap, Hexfile, UpdateFile, ...) without the Windows files, for the harnesses below
ELV="$SRC/src/libelvutils"
ELV_SRC=()
for f in "$ELV"/*.cpp; do
  case "$f" in *Win32* | */md5.cpp) ;; *) ELV_SRC+=("$f") ;; esac
done
HM2="$SRC/src/rfd/hm2"
echo "building fuzz_ccu2_frame"
"$CXX" "${FLAGS[@]}" -I"$HM2" -I"$SRC/src/rfd" -I"$SRC/src/libhsscomm" -I"$ELV" "$HERE/fuzz_ccu2_frame.cpp" \
  "$HM2/CCU2SerialFrame.cpp" "$HM2/CCU2CoprocessorCommand.cpp" "$HM2/HM2Utils.cpp" "${ELV_SRC[@]}" -lpthread \
  -o "$OUT/fuzz_ccu2_frame"
echo "building fuzz_hmwlgw_frame"
"$CXX" "${FLAGS[@]}" -I"$SRC/src/hs485d" -I"$ELV" "$HERE/fuzz_hmwlgw_frame.cpp" \
  "$SRC/src/hs485d/HMWLGWTransportFrame.cpp" "$SRC/src/hs485d/HMWLGWCommand.cpp" "${ELV_SRC[@]}" -lpthread \
  -o "$OUT/fuzz_hmwlgw_frame"
n=0
for name in fuzz_propertymap fuzz_hexfile fuzz_updatefile; do
  echo "building $name"
  "$CXX" "${FLAGS[@]}" -DFORMAT=$n -I"$ELV" "$HERE/fuzz_file_formats.cpp" "${ELV_SRC[@]}" -lpthread -o "$OUT/$name"
  n=$((n + 1))
done
echo "building fuzz_json"
"$CXX" "${FLAGS[@]}" -I"$SRC/src/rfd" "$HERE/fuzz_json.cpp" "$SRC/src/rfd/JSONObject.cpp" -o "$OUT/fuzz_json"
echo "fuzz harnesses in $OUT"
