//! Generated SpiceDB v1 client. Regenerate by updating the vendored protos in `/proto`.
#![allow(clippy::all, missing_docs)]

pub mod authzed {
    pub mod api {
        pub mod v1 {
            tonic::include_proto!("authzed.api.v1");
        }
    }
}
pub mod google {
    pub mod api {
        tonic::include_proto!("google.api");
    }
    pub mod rpc {
        tonic::include_proto!("google.rpc");
    }
}
pub mod validate {
    tonic::include_proto!("validate");
}
pub mod buf {
    pub mod validate {
        tonic::include_proto!("buf.validate");
    }
}
pub mod grpc {
    pub mod gateway {
        pub mod protoc_gen_openapiv2 {
            pub mod options {
                tonic::include_proto!("grpc.gateway.protoc_gen_openapiv2.options");
            }
        }
    }
}

pub use authzed::api::v1;
