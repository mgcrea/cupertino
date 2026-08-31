# The source of truth for the cask. It does not live here to be installed from —
# Homebrew reads casks out of a tap — but so that the version and sha256 are
# bumped by the same CI job that produced the artifact they describe, rather than
# by hand in another repository afterwards. The `release-app` job renders this
# file and pushes it to mgcrea/homebrew-tap as Casks/cupertino.rb.
#
# The two placeholders below are substituted by that job from the artifact it
# just built and checksummed.
cask "cupertino" do
  version "@@VERSION@@"
  sha256 "@@SHA256@@"

  url "https://github.com/mgcrea/cupertino/releases/download/app-v#{version}/Cupertino.zip",
      verified: "github.com/mgcrea/cupertino/"
  name "Cupertino"
  desc "Menu bar broker giving MCP clients access to your Apple apps"
  homepage "https://cupertino.mgcrea.io/"

  livecheck do
    url :url
    strategy :github_latest
    # The tag prefix is `app-v`, not `v`: this is a monorepo and the npm packages
    # tag as `mail-v*`, `core-v*` and so on. A bare /v(\d+)/ would happily match
    # a core release and offer it as an app update.
    regex(%r{^app[-/]v?(\d+(?:\.\d+)+)$}i)
  end

  # Cupertino updates itself through Sparkle, so `brew upgrade` leaves it alone
  # (only `--greedy` touches it) and the two never race to replace the same
  # bundle. Note the asymmetry this creates and it is deliberate: brew is the
  # install channel and the way off 1.0.0, which shipped with no updater in it;
  # Sparkle owns the copy afterwards.
  auto_updates true
  depends_on macos: :tahoe

  app "Cupertino.app"

  uninstall quit: "io.mgcrea.cupertino"

  zap trash: [
    "~/Library/Application Support/io.mgcrea.cupertino",
    "~/Library/Caches/io.mgcrea.cupertino",
    "~/Library/HTTPStorages/io.mgcrea.cupertino",
    "~/Library/Preferences/io.mgcrea.cupertino.plist",
    "~/Library/Saved Application State/io.mgcrea.cupertino.savedState",
  ]

  caveats <<~EOS
    Cupertino needs Full Disk Access. Grant it in
    System Settings > Privacy & Security > Full Disk Access.

    Two things `brew uninstall --zap` cannot remove, because no unprivileged
    process is allowed to:

      * the Full Disk Access grant itself. To clear it:
          sudo tccutil reset SystemPolicyAllFiles io.mgcrea.cupertino

      * the login item, if you enabled it. Turn it off in Cupertino's settings
        before uninstalling, or clear it later in
        System Settings > General > Login Items.

    MCP client configs that Cupertino wrote hold an absolute path to
    Contents/Helpers/cupertino-bridge, and uninstalling does not revisit them.
  EOS
end
