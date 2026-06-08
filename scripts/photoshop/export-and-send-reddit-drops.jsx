/*
 * Photoshop Action script for Reddit Drops.
 *
 * Recommended action order:
 * 1. Run your existing watermark steps.
 * 2. Run this script via File > Scripts > Browse...
 *
 * It exports the active document as PNG when possible:
 *   /Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/Subreddit_postId.png
 *
 * If PNG is larger than 20MB, it falls back to JPEG:
 *   /Users/nikolamarkovic/Desktop/private/photo-edit/PSR Exports/Subreddit_postId.jpg
 *
 * Then uploads it to:
 *   nmarkovic@192.168.0.26:~/reddit_drops/Subreddit_postId.{png|jpg}
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
  var MAX_PNG_BYTES = 20 * 1024 * 1024;

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
  var pngFile = new File(exportFolder.fsName + "/" + baseName + ".png");
  var jpgFile = new File(exportFolder.fsName + "/" + baseName + ".jpg");
  var outFile = pngFile;

  var pngOptions = new PNGSaveOptions();
  pngOptions.compression = 6;
  pngOptions.interlaced = false;

  doc.saveAs(pngFile, pngOptions, true, Extension.LOWERCASE);

  if (pngFile.length > MAX_PNG_BYTES) {
    var jpgOptions = new JPEGSaveOptions();
    jpgOptions.quality = 10;
    jpgOptions.embedColorProfile = true;
    jpgOptions.formatOptions = FormatOptions.STANDARDBASELINE;
    jpgOptions.matte = MatteType.WHITE;

    doc.saveAs(jpgFile, jpgOptions, true, Extension.LOWERCASE);
    pngFile.remove();
    outFile = jpgFile;
  }

  var uploadScript = new File(UPLOAD_SCRIPT);
  if (!uploadScript.exists) {
    throw new Error("Upload script not found: " + UPLOAD_SCRIPT);
  }

  var command = shellQuote(uploadScript.fsName) + " " + shellQuote(outFile.fsName);
  var result = app.system(command);

  if (!result || String(result).indexOf("Upload complete:") === -1) {
    throw new Error(
      "Upload failed. Check ~/Library/Logs/fixtral/reddit-drops-scp.log\n\n" +
        result
    );
  }

  alert("Exported and uploaded: " + outFile.fsName);
})();
