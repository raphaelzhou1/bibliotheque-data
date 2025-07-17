// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

interface BookMetadata {
  title: string;
  author: string;
  language: string;
  file: File;
  side: 'foreign' | 'native';
}

interface UploadRequest {
  foreignFile: File;
  nativeFile: File;
  foreignTitle: string;
  foreignAuthor: string;
  foreignLanguage: string;
  nativeTitle: string;
  nativeAuthor: string;
  nativeLanguage: string;
  visibility: 'public' | 'private';
  ownerId: string;
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

    // Validate file types
    if (!foreignFile.name.endsWith('.epub') || !nativeFile.name.endsWith('.epub')) {
      return new Response(
        JSON.stringify({ error: 'Only EPUB files are supported' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      )
    }

    // Helper function to upload file to storage
    const uploadFileToStorage = async (file: File, filename: string) => {
      const bucketName = visibility === 'public' ? 'public-books' : 'private-books'
      
      // Create bucket if it doesn't exist
      const { error: bucketError } = await supabase.storage.createBucket(bucketName, {
        public: visibility === 'public'
      })
      
      // Ignore error if bucket already exists
      if (bucketError && !bucketError.message.includes('already exists')) {
        console.error('Bucket creation error:', bucketError)
      }

      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(filename, file, {
          cacheControl: '3600',
          upsert: false,
          metadata: {
            owner_id: ownerId
          }
        })

      if (error) {
        throw new Error(`File upload failed: ${error.message}`)
      }

      return data.path
    }

    // Helper function to create book record
    const createBookRecord = async (metadata: BookMetadata, epubPath: string) => {
      const bookData = {
        owner_id: ownerId,
        visibility: visibility as 'public' | 'private',
        language_code: metadata.language || 'en',
        side: metadata.side,
        title: metadata.title || metadata.file.name.replace('.epub', ''),
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

    // Generate unique filenames
    const timestamp = Date.now()
    const foreignFilename = `${ownerId}/foreign_${timestamp}_${foreignFile.name}`
    const nativeFilename = `${ownerId}/native_${timestamp}_${nativeFile.name}`

    // Upload files to storage
    console.log('Uploading foreign book:', foreignFilename)
    const foreignEpubPath = await uploadFileToStorage(foreignFile, foreignFilename)
    
    console.log('Uploading native book:', nativeFilename)
    const nativeEpubPath = await uploadFileToStorage(nativeFile, nativeFilename)

    // Create book records
    console.log('Creating foreign book record')
    const foreignBook = await createBookRecord({
      title: foreignTitle,
      author: foreignAuthor,
      language: foreignLanguage,
      file: foreignFile,
      side: 'foreign'
    }, foreignEpubPath)

    console.log('Creating native book record')
    const nativeBook = await createBookRecord({
      title: nativeTitle,
      author: nativeAuthor,
      language: nativeLanguage,
      file: nativeFile,
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
      await supabase.storage.from(visibility === 'public' ? 'public-books' : 'private-books').remove([foreignEpubPath, nativeEpubPath])
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
      JSON.stringify({ error: error.message || 'An unexpected error occurred' }),
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
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/add-new-book' \
    --header 'Authorization: Bearer [YOUR_TOKEN]' \
    --header 'Content-Type: multipart/form-data' \
    --form 'foreignFile=@/path/to/foreign.epub' \
    --form 'nativeFile=@/path/to/native.epub' \
    --form 'foreignTitle=Le Petit Prince' \
    --form 'foreignAuthor=Antoine de Saint-Exupéry' \
    --form 'foreignLanguage=fr' \
    --form 'nativeTitle=The Little Prince' \
    --form 'nativeAuthor=Antoine de Saint-Exupéry' \
    --form 'nativeLanguage=en' \
    --form 'visibility=public' \
    --form 'ownerId=[USER_ID]'

*/
