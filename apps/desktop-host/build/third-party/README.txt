Release dependency licensing evidence
====================================

These files are upstream license/notice texts and publisher metadata used to
build RiaCore's release attribution bundle. Their presence does not license the
private RiaCoreDev repository. Each third-party component retains its own terms.

npm-supplements.json pins package versions, upstream source URLs and SHA-256
digests for archives which omit license files. Most npm licenses are copied
directly from installed packages, including nested versions and notices. The
collector preserves publisher metadata and canonical terms for the reviewed
binary@0.3.0, chainsaw@0.1.0 and node-buffers@0.1.1 archives, which explicitly
declare MIT/MIT-X11 but have no separate license file. It never assumes a
license for an undeclared package; buffers@0.1.1 is replaced by node-buffers.

terms-*.txt are canonical texts from SPDX license-list-data v3.27.0, except
additional terms captured from NuGet's publisher license expression. Package
specific copyright and attribution remain in upstream license files and
publisher metadata; canonical templates are not substituted for attribution.
https://github.com/spdx/license-list-data/tree/v3.27.0/text

native-manifest.json pins the portable Git payload, LadybugDB source release,
Git LFS Go modules and Credential Manager/.NET package versions. It records
upstream URLs and document hashes. Go license files are collected from exact
version ZIPs at proxy.golang.org. NuGet files preserve nuspec authors,
copyright, license expression/file and repository commit, together with
embedded license and notice documents. Linux and Windows native asset notices
are conservatively retained alongside macOS evidence.

LadybugDB licenses are taken from the v0.19.1 source tree's LICENSE and
third_party license files. Node's full distribution LICENSE and Electron's
LICENSE and LICENSES.chromium.html are collected from the build runtime and
downloaded Electron distribution, not from these supplemental texts.

Updating dependencies
---------------------

1. Update the lockfile and stage the platform payloads.
2. Preserve exact upstream copyright/license/NOTICE documents and publisher
   evidence for new versions; record source URLs and SHA-256 hashes.
3. Review unfamiliar license expressions and alternate-license choices.
4. Update the native version inventory when the supplier's components change.
5. Run packaging and validation on each platform. Validation rejects unknown
   npm licenses, absent texts, unreviewed native versions and missing or changed
   packaged notices. This checks packaging evidence, not legal entitlement.

The generated resources/licenses/inventory.json is a component/license
inventory, not a claimed SPDX or CycloneDX SBOM. SOURCE-CODE.txt records source
locations and upstream build recipes. Distributors remain responsible for
applicable corresponding-source obligations and Microsoft redistribution terms.
