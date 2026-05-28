/*
 * Photoshop Action script for Reddit Drops.
 *
 * Recommended action order:
 * 1. Run your existing watermark steps.
 * 2. Run this script via File > Scripts > Browse...
 *
 * It exports the active document as:
 *   /Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/Subreddit_postId.png
 *
 * Then uploads it to:
 *   nmarkovic@192.168.0.26:~/reddit_drops/Subreddit_postId.png
 */

#target photoshop

(function () {
  if (!app.documents.length) {
    throw new Error("No active Photoshop document.");
  }

  var EXPORT_DIR =
    "/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports";
  var UPLOAD_SCRIPT =
    "/Users/nikolamarkovic/Desktop/private/photo-edit/fixtral/scripts/photoshop/reddit-drops-upload.sh";

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function baseNameFromDocumentName(name) {
    return String(name).replace(/\.[^\.]+$/, "");
  }

  function ensureFolder(path) {
    var folder = new Folder(path);
    if (!folder.exists && !folder.create()) {
      throw new Error("Could not create export folder: " + path);
    }
    return folder;
  }

  var doc = app.activeDocument;
  var baseName = baseNameFromDocumentName(doc.name);
  var exportFolder = ensureFolder(EXPORT_DIR);
  var outFile = new File(exportFolder.fsName + "/" + baseName + ".png");

  var pngOptions = new PNGSaveOptions();
  pngOptions.compression = 6;
  pngOptions.interlaced = false;

  doc.saveAs(outFile, pngOptions, true, Extension.LOWERCASE);

  var uploadScript = new File(UPLOAD_SCRIPT);
  if (!uploadScript.exists) {
    throw new Error("Upload script not found: " + UPLOAD_SCRIPT);
  }

  var command = shellQuote(uploadScript.fsName) + " " + shellQuote(outFile.fsName);
  var result = app.system(command);

  if (result && String(result).toLowerCase().indexOf("error") !== -1) {
    throw new Error("Upload may have failed: " + result);
  }

  alert("Exported and uploaded: " + outFile.fsName);
})();
