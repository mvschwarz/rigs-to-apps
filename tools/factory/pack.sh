#!/bin/sh
# Build a factory PACKAGE on Linux, in the rigs-to-builder environment.
#
#   sudo -n true && sh tools/factory/pack.sh <factory-src-dir> <out-dir>
#
# 1. Stage the source where the neutral builder user can read it.
# 2. In a UTS namespace (hostname "rigs-to-builder"), as the neutral `rigsto`
#    user with a scrubbed environment, run a builder-only OpenRig daemon and
#    `rig bundle create` for every rig and model variant. The bundles' provenance
#    therefore reads sourceHost "rigs-to-builder" and carries no session. The
#    machine's own hostname is never changed.
# 3. Assemble the package (tools/factory/assemble.mjs) and pack it with GNU tar:
#    no xattrs, sorted names, fixed mtime and owner, gzip -n, so the same inputs
#    give the same archive hash.
set -eu
SRC=$(cd "$1" && pwd); OUT=$(mkdir -p "$2" && cd "$2" && pwd)
TOOLS=$(cd "$(dirname "$0")/.." && pwd)
ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id)' "$SRC/factory.json")
VER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$SRC/factory.json")
BUILDER_USER=${BUILDER_USER:-rigsto}
BUILDER_PORT=${BUILDER_PORT:-7554}
# A version is immutable: a published or tested package is never rebuilt under
# the same name. Bump "version" in factory.json instead.
for p in "$OUT/$ID-$VER" "$OUT/$ID-$VER.tar.gz" "$OUT/$ID-$VER.tar.gz.sha256"; do
  if [ -e "$p" ]; then echo "FAIL: $p already exists — $ID $VER is already built; bump the version"; exit 1; fi
done
# The private-path gate runs before anything is built.
node "$TOOLS/factory/precheck.mjs" "$SRC"
STAGE=/tmp/rigs-to-builder/pack-$ID-$VER
rm -rf "$STAGE" && mkdir -p "$STAGE/bundles" && cp -R "$SRC" "$STAGE/src" && chmod -R a+rX "$STAGE" && chmod a+w "$STAGE/bundles"

# the bundle create list: one line per rig variant — "<spec path> <out name> <bundle name>"
node -e '
const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
for (const r of f.rigs) for (const [v, file] of Object.entries(r.variants))
  console.log(`${process.argv[2]}/src/${r.dir}/${file} ${v==="recommended"?r.id+".rigbundle":r.id+"."+v+"-models.rigbundle"} ${v==="recommended"?r.id:r.id+"-"+v+"-models"}`);
' "$SRC/factory.json" "$STAGE" > "$STAGE/creates.txt"
chmod a+r "$STAGE/creates.txt"

sudo -n unshare --uts sh -c "
  hostname rigs-to-builder
  sudo -n -u $BUILDER_USER -H env -i HOME=/home/$BUILDER_USER PATH=/home/$BUILDER_USER/npm/bin:/usr/bin:/bin \
    OPENRIG_HOME=/home/$BUILDER_USER/rigs-to-builder/openrig OPENRIG_URL=http://127.0.0.1:$BUILDER_PORT sh -c '
      set -eu
      test \"\$(hostname)\" = rigs-to-builder
      mkdir -p /home/$BUILDER_USER/rigs-to-builder/openrig
      rig daemon start --port $BUILDER_PORT --host 127.0.0.1 --no-kernel >/dev/null 2>&1 || true
      while read spec out name; do
        rig bundle create \"\$spec\" -o $STAGE/bundles/\$out --name \"\$name\" --bundle-version $VER --json >/dev/null
        echo \"  built \$out\"
      done < $STAGE/creates.txt
    '
"

PKG="$OUT/$ID-$VER"
node "$TOOLS/factory/assemble.mjs" "$STAGE/src" "$STAGE/bundles" "$PKG"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --no-xattrs --no-acls --format=gnu \
  -C "$OUT" -cf - "$ID-$VER" | gzip -n -9 > "$OUT/$ID-$VER.tar.gz"
( cd "$OUT" && sha256sum "$ID-$VER.tar.gz" > "$ID-$VER.tar.gz.sha256" && cat "$ID-$VER.tar.gz.sha256" )
