// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"
import JSZip from "jszip"

interface BookMetadata {
  title: string;
  author: string;
  language: string;
  originalFilename: string;
  side: 'foreign' | 'native';
}

interface ProcessedFile {
  data: Uint8Array;
  filename: string;
  originalSize: number;
  compressedSize: number;
}

// Helper function to sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\-_.]/g, '_') // Replace special chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(" ", '') // Remove leading/trailing underscores
    .toLowerCase();
}

console.log("Add new book function loaded!")

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    })
  }

  try {
    // Get Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Parse form data
    const formData = await req.formData()
    
    const foreignFile = formData.get('foreignFile') as File
    const nativeFile = formData.get('nativeFile') as File
    const foreignTitle = formData.get('foreignTitle') as string
    const foreignAuthor = formData.get('foreignAuthor') as string
    const foreignLanguage = formData.get('foreignLanguage') as string
    const nativeTitle = formData.get('nativeTitle') as string
    const nativeAuthor = formData.get('nativeAuthor') as string
    const nativeLanguage = formData.get('nativeLanguage') as string
    const visibility = formData.get('visibility') as string
    const ownerId = formData.get('ownerId') as string

    // Validate required fields
    if (!foreignFile || !nativeFile || !ownerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: foreignFile, nativeFile, ownerId' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      )
    }

    console.log(`Processing files: ${foreignFile.name} (${foreignFile.size} bytes), ${nativeFile.name} (${nativeFile.size} bytes)`)

    // Helper function to process uploaded file (ZIP or direct EPUB)
    const processUploadedFile = async (file: File, expectedSide: 'foreign' | 'native'): Promise<ProcessedFile> => {
      const arrayBuffer = await file.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)
      
      // Check if it's a ZIP file
      if (file.name.endsWith('.zip') || file.type === 'application/zip') {
        console.log(`Decompressing ZIP file: ${file.name}`)
        
        try {
          const zip = await JSZip.loadAsync(uint8Array)
          
          // Find EPUB files in the ZIP
          const epubFiles = Object.keys(zip.files).filter(filename => 
            filename.endsWith('.epub') && !zip.files[filename].dir
          )
          
          if (epubFiles.length === 0) {
            throw new Error(`No EPUB files found in ${file.name}`)
          }
          
          if (epubFiles.length > 1) {
            console.warn(`Multiple EPUB files found in ${file.name}, using first one: ${epubFiles[0]}`)
          }
          
          const epubFilename = epubFiles[0]
          const epubFile = zip.files[epubFilename]
          const epubData = await epubFile.async('uint8array')
          
          console.log(`Extracted ${epubFilename} from ZIP: ${epubData.length} bytes (was ${file.size} bytes compressed)`)
          
          return {
            data: epubData,
            filename: epubFilename,
            originalSize: epubData.length,
            compressedSize: file.size
          }
        } catch (error) {
          throw new Error(`Failed to decompress ZIP file ${file.name}: ${error.message}`)
        }
      } else if (file.name.endsWith('.epub')) {
        // Direct EPUB file
        return {
          data: uint8Array,
          filename: file.name,
          originalSize: file.size,
          compressedSize: file.size
        }
      } else {
        throw new Error(`Unsupported file type: ${file.name}. Only EPUB and ZIP files are supported.`)
      }
    }

    // Helper function to ensure storage bucket exists with proper configuration
    const ensureBucketExists = async (bucketName: string, isPublic: boolean) => {
      console.log(`Ensuring bucket exists: ${bucketName} (public: ${isPublic})`)
      
      // Try to create bucket
      const { data: bucketData, error: bucketError } = await supabase.storage.createBucket(bucketName, {
        public: isPublic,
        allowedMimeTypes: ['application/epub+zip', 'application/zip'],
        fileSizeLimit: 52428800, // 50MB in bytes
      })
      
      if (bucketError) {
        if (bucketError.message.includes('already exists')) {
          console.log(`Bucket ${bucketName} already exists`)
          
          // Update bucket settings if it exists but might have wrong config
          const { error: updateError } = await supabase.storage.updateBucket(bucketName, {
            public: isPublic,
            allowedMimeTypes: ['application/epub+zip', 'application/zip'],
            fileSizeLimit: 52428800,
          })
          
          if (updateError) {
            console.warn(`Could not update bucket settings: ${updateError.message}`)
          }
        } else {
          throw new Error(`Failed to create bucket ${bucketName}: ${bucketError.message}`)
        }
      } else {
        console.log(`Created new bucket: ${bucketName}`)
      }
    }

    // Helper function to upload file to storage
    const uploadFileToStorage = async (fileData: Uint8Array, originalFilename: string, side: 'foreign' | 'native') => {
      const bucketName = visibility === 'public' ? 'public-books' : 'private-books'
      
      // Ensure bucket exists
      await ensureBucketExists(bucketName, visibility === 'public')

      // Sanitize filename and create storage path
      const sanitizedFilename = sanitizeFilename(originalFilename)
      const timestamp = Date.now()
      const storagePath = `${ownerId}/${side}_${timestamp}_${sanitizedFilename}`
      
      console.log(`Original filename: ${originalFilename}`)
      console.log(`Sanitized storage path: ${storagePath}`)

      // Create a Blob from the Uint8Array for upload
      const blob = new Blob([fileData], { type: 'application/epub+zip' })
      
      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(storagePath, blob, {
          cacheControl: '3600',
          upsert: false,
          metadata: {
            owner_id: ownerId,
            original_size: fileData.length.toString(),
            original_filename: originalFilename,
          }
        })

      if (error) {
        console.error(`Storage upload error:`, error)
        throw new Error(`File upload failed: ${error.message}`)
      }

      console.log(`Successfully uploaded to: ${data.path}`)
      return data.path
    }

    // Helper function to create book record
    const createBookRecord = async (metadata: BookMetadata, epubPath: string) => {
      const bookData = {
        owner_id: ownerId,
        visibility: visibility as 'public' | 'private',
        language_code: metadata.language || 'en',
        side: metadata.side,
        title: metadata.title || metadata.originalFilename.replace('.epub', ''),
        author: metadata.author || '',
        epub_path: epubPath,
        published_on: null,
        cover_url: null,
        json_blob: null,
        is_deleted: false
      }

      const { data, error } = await supabase
        .from('books')
        .insert(bookData)
        .select()
        .single()

      if (error) {
        throw new Error(`Book creation failed: ${error.message}`)
      }

      return data
    }

    // Process uploaded files
    console.log('Processing foreign file...')
    const foreignProcessed = await processUploadedFile(foreignFile, 'foreign')
    
    console.log('Processing native file...')
    const nativeProcessed = await processUploadedFile(nativeFile, 'native')

    // Upload files to storage with sanitized names
    console.log('Uploading foreign book to storage...')
    const foreignEpubPath = await uploadFileToStorage(foreignProcessed.data, foreignProcessed.filename, 'foreign')
    
    console.log('Uploading native book to storage...')
    const nativeEpubPath = await uploadFileToStorage(nativeProcessed.data, nativeProcessed.filename, 'native')

    // Create book records
    console.log('Creating foreign book record')
    const foreignBook = await createBookRecord({
      title: foreignTitle,
      author: foreignAuthor,
      language: foreignLanguage,
      originalFilename: foreignProcessed.filename,
      side: 'foreign'
    }, foreignEpubPath)

    console.log('Creating native book record')
    const nativeBook = await createBookRecord({
      title: nativeTitle,
      author: nativeAuthor,
      language: nativeLanguage,
      originalFilename: nativeProcessed.filename,
      side: 'native'
    }, nativeEpubPath)

    // Create book pair
    console.log('Creating book pair')
    const { data: bookPair, error: pairError } = await supabase
      .from('book_pairs')
      .insert({
        owner_id: ownerId,
        foreign_book_id: foreignBook.id,
        native_book_id: nativeBook.id,
        alignment: null
      })
      .select()
      .single()

    if (pairError) {
      // Clean up uploaded files and created books on failure
      const bucketName = visibility === 'public' ? 'public-books' : 'private-books'
      await supabase.storage.from(bucketName).remove([foreignEpubPath, nativeEpubPath])
      await supabase.from('books').delete().eq('id', foreignBook.id)
      await supabase.from('books').delete().eq('id', nativeBook.id)
      
      throw new Error(`Book pair creation failed: ${pairError.message}`)
    }

    console.log('Successfully created book pair:', bookPair.id)

    return new Response(
      JSON.stringify({ 
        success: true,
        bookPairId: bookPair.id,
        foreignBookId: foreignBook.id,
        nativeBookId: nativeBook.id,
        compressionInfo: {
          foreignOriginalSize: foreignProcessed.originalSize,
          foreignCompressedSize: foreignProcessed.compressedSize,
          nativeOriginalSize: nativeProcessed.originalSize,
          nativeCompressedSize: nativeProcessed.compressedSize,
          compressionRatio: ((foreignProcessed.compressedSize + nativeProcessed.compressedSize) / 
                           (foreignProcessed.originalSize + nativeProcessed.originalSize) * 100).toFixed(1) + '%'
        },
        message: 'Books uploaded and paired successfully!'
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    )

  } catch (error) {
    console.error('Error in add-new-book function:', error)
    return new Response(
      JSON.stringify({ 
        error: error.message || 'An unexpected error occurred',
        hint: error.message?.includes('decompress') ? 
          'Try uploading the EPUB files directly without compression, or ensure the ZIP file contains valid EPUB files.' :
          error.message?.includes('Invalid key') ?
          'Filename contains invalid characters. Please rename your file to use only letters, numbers, hyphens, and underscores.' :
          'Check file size limits and ensure files are valid EPUB format.'
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    )
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request with ZIP or EPUB files:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/add-new-book' \
    --header 'Authorization: Bearer [YOUR_TOKEN]' \
    --header 'Content-Type: multipart/form-data' \
    --form 'foreignFile=@/path/to/foreign.zip' \
    --form 'nativeFile=@/path/to/native.zip' \
    --form 'foreignTitle=Le Petit Prince' \
    --form 'foreignAuthor=Antoine de Saint-Exupéry' \
    --form 'foreignLanguage=fr' \
    --form 'nativeTitle=The Little Prince' \
    --form 'nativeAuthor=Antoine de Saint-Exupéry' \
    --form 'nativeLanguage=en' \
    --form 'visibility=public' \
    --form 'ownerId=[USER_ID]'

*/
