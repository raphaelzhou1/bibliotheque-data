// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

// Helper function to sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\-_.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(" ", '')
    .toLowerCase();
}

// Helper function to ensure storage bucket exists with proper configuration
async function ensureBucketExists(supabase: any, bucketName: string, isPublic: boolean) {
  console.log(`Ensuring bucket exists: ${bucketName} (public: ${isPublic})`);
  
  // Try to create bucket
  const { data: bucketData, error: bucketError } = await supabase.storage.createBucket(bucketName, {
    public: isPublic,
    allowedMimeTypes: ['application/epub+zip', 'application/zip'],
    fileSizeLimit: 52428800, // 50MB in bytes
  });
  
  if (bucketError) {
    if (bucketError.message.includes('already exists')) {
      console.log(`Bucket ${bucketName} already exists`);
      
      // Update bucket settings if it exists but might have wrong config
      const { error: updateError } = await supabase.storage.updateBucket(bucketName, {
        public: isPublic,
        allowedMimeTypes: ['application/epub+zip', 'application/zip'],
        fileSizeLimit: 52428800,
      });
      
      if (updateError) {
        console.warn(`Could not update bucket settings: ${updateError.message}`);
      }
    } else {
      throw new Error(`Failed to create bucket ${bucketName}: ${bucketError.message}`);
    }
  } else {
    console.log(`Created new bucket: ${bucketName}`);
  }
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    });
  }

  try {
    // Get Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const body = await req.json();
    const { 
      data, 
      filename, 
      side, 
      ownerId, 
      visibility = 'private',
      originalSize,
      compressedSize 
    } = body;
    
    if (!data || !filename || !side || !ownerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: data, filename, side, ownerId' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    console.log(`Uploading ${side} file: ${filename} for user ${ownerId}`);
    
    // Convert base64 back to Uint8Array
    const fileData = new Uint8Array(atob(data).split('').map(char => char.charCodeAt(0)));
    
    // Determine bucket based on visibility
    const bucketName = visibility === 'public' ? 'public-books' : 'private-books';
    
    // Ensure bucket exists
    await ensureBucketExists(supabase, bucketName, visibility === 'public');

    // Sanitize filename and create storage path
    const sanitizedFilename = sanitizeFilename(filename);
    const timestamp = Date.now();
    const storagePath = `${ownerId}/${side}_${timestamp}_${sanitizedFilename}`;
    
    console.log(`Original filename: ${filename}`);
    console.log(`Sanitized storage path: ${storagePath}`);

    // Create a Blob from the Uint8Array for upload
    const blob = new Blob([fileData], { type: 'application/epub+zip' });
    
    const uploadStartTime = Date.now();
    const { data: uploadData, error } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, blob, {
        cacheControl: '3600',
        upsert: false,
        metadata: {
          owner_id: ownerId,
          original_size: (originalSize || fileData.length).toString(),
          compressed_size: (compressedSize || fileData.length).toString(),
          original_filename: filename,
          side: side,
          upload_timestamp: new Date().toISOString()
        }
      });
    
    const uploadTime = Date.now() - uploadStartTime;

    if (error) {
      console.error(`Storage upload error:`, error);
      throw new Error(`File upload failed: ${error.message}`);
    }

    console.log(`Successfully uploaded to: ${uploadData.path} in ${uploadTime}ms`);
    
    // Get the public URL if the bucket is public
    let publicUrl = null;
    if (visibility === 'public') {
      const { data: urlData } = supabase.storage
        .from(bucketName)
        .getPublicUrl(storagePath);
      publicUrl = urlData.publicUrl;
    }

    return new Response(
      JSON.stringify({
        success: true,
        storagePath: uploadData.path,
        bucketName: bucketName,
        publicUrl: publicUrl,
        uploadTime: uploadTime,
        fileSize: fileData.length,
        metadata: {
          originalFilename: filename,
          sanitizedFilename: sanitizedFilename,
          side: side,
          ownerId: ownerId,
          visibility: visibility,
          originalSize: originalSize || fileData.length,
          compressedSize: compressedSize || fileData.length
        }
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );

  } catch (error) {
    console.error('Error in upload-to-storage function:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'File upload failed',
        hint: 'Check file size limits and ensure you have proper permissions'
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/upload-to-storage' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
