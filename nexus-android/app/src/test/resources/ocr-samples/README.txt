OCR replay samples (ReplayTest.kt). One file = one scan of one pack (1-5 photos).
The text is what ML Kit would return, typed by hand with realistic OCR mistakes. No images.

  # comment
  id: <name>
  expect.<field>: <value>     fields: mrp weight mfg exp brand name barcode; "-" = must be empty
                              name = words that must all appear (any order, any case)
                              mrp_alts (optional) = values that must be offered as alternate chips
  == photo                    starts the next photo
  barcode: <digits> <FORMAT>  ML Kit barcode on this photo (optional)
  -- latin                    OCR pass on the photo as taken
  -- latin enhanced           OCR pass on the contrast-enhanced / sharpened copy
  -- latin rot90 | rot270     OCR pass with the photo turned (sideways text)
  -- devanagari               Devanagari OCR pass

OCR line:  h[,top[,left[,width[,conf]]]]|text   (box height/top/left/width in px, ML Kit confidence 0-1)
           or just the text (height 14, top = line index * 40, no position, no confidence)
